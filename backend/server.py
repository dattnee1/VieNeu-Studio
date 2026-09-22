"""
VieNeu Studio backend.

A thin local API around the `vieneu` SDK, configured for VieNeu-TTS v3 Turbo
(48 kHz, torch-free ONNX on CPU / auto PyTorch on CUDA). The Electron shell
spawns this on localhost and talks to it over HTTP.

Run standalone for development:
    python server.py --port 8722
"""
import argparse
import base64
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

# Force single-threaded math ops BEFORE importing onnxruntime/vieneu — CPU
# multi-threaded float reduction isn't perfectly order-stable run to run,
# which can cause tiny audio differences even with the same seed+voice.
# Trade-off: slightly slower inference, in exchange for repeatable takes.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

# pyrefly: ignore [missing-import]
from fastapi import FastAPI, HTTPException, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

# --- VieNeu SDK -------------------------------------------------------------
# mode="v3turbo" -> 48kHz, built-in speaker tokens, emotion cues, cloning,
# batched multi-speaker Conversation mode. CPU runs on ONNX (torch-free);
# a CUDA machine auto-switches to the PyTorch engine.
from vieneu import Vieneu  # noqa: E402  (factory function, not a class)
from vieneu.base import BaseVieneuTTS  # noqa: E402  (base class dùng cho type annotations)

OUTPUT_DIR = Path(tempfile.gettempdir()) / "vieneu_studio_outputs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

PREVIEW_DIR = OUTPUT_DIR / "previews"
PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

PIPER_MODELS_DIR = Path(os.environ.get("PIPER_MODELS_DIR", Path(__file__).parent / "piper_models"))
PIPER_MODELS_DIR.mkdir(parents=True, exist_ok=True)

VOICES_META_PATH = Path(__file__).parent / "voices_meta.json"
PREVIEW_TEXT = "Xin chào, đây là giọng đọc mẫu."


def _get_ffmpeg_exe() -> Optional[str]:
    """Find ffmpeg executable from PATH or imageio_ffmpeg."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        # pyrefly: ignore [missing-import]
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _load_voice_meta() -> dict:
    try:
        data = json.loads(VOICES_META_PATH.read_text(encoding="utf-8"))
        data.pop("_comment", None)
        return data
    except Exception:
        return {}


_tts: Optional[BaseVieneuTTS] = None
_init_error: Optional[str] = None
_threads_setting = 1  # default: bit-exact reproducibility over raw speed
_device_setting = "cpu"  # default: CPU (safe for AMD / machines without CUDA)
_tts_lock = threading.Lock()  # protects _tts during lazy-init and hot-reload


def _cpu_thread_ceiling() -> int:
    return os.cpu_count() or 8


def _detect_gpu_info() -> dict:
    """Detect available GPU hardware without requiring GPU libraries to be loaded."""
    gpus = []

    # --- NVIDIA via torch (if available) ---
    try:
        import torch
        if torch.cuda.is_available():
            for i in range(torch.cuda.device_count()):
                gpus.append({
                    "index": i,
                    "name": torch.cuda.get_device_name(i),
                    "type": "NVIDIA (CUDA)",
                    "vram_mb": round(torch.cuda.get_device_properties(i).total_memory / 1024 / 1024),
                })
    except Exception:
        pass

    # --- NVIDIA via nvidia-smi (fallback) ---
    if not gpus:
        try:
            out = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=index,name,memory.total",
                 "--format=csv,noheader,nounits"],
                timeout=4, text=True, stderr=subprocess.DEVNULL
            )
            for line in out.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 3:
                    gpus.append({
                        "index": int(parts[0]),
                        "name": parts[1],
                        "type": "NVIDIA (CUDA)",
                        "vram_mb": int(parts[2]) if parts[2].isdigit() else None,
                    })
        except Exception:
            pass

    # --- AMD / Intel via wmic (Windows) ---
    if platform.system() == "Windows":
        try:
            out = subprocess.check_output(
                ["wmic", "path", "win32_VideoController", "get",
                 "Name,AdapterRAM", "/format:csv"],
                timeout=4, text=True, stderr=subprocess.DEVNULL
            )
            for line in out.strip().splitlines():
                line = line.strip()
                if not line or line.startswith("Node"):
                    continue
                parts = line.split(",")
                if len(parts) >= 3:
                    ram_bytes = parts[1].strip()
                    name = parts[2].strip()
                    if name and not any(g["name"] == name for g in gpus):
                        vram_mb = None
                        try:
                            vram_mb = round(int(ram_bytes) / 1024 / 1024)
                        except Exception:
                            pass
                        gpu_type = "NVIDIA" if "NVIDIA" in name.upper() else (
                            "AMD" if "AMD" in name.upper() or "RADEON" in name.upper() else (
                                "Intel" if "INTEL" in name.upper() else "GPU"
                            )
                        )
                        # AMD/Intel GPUs don't support CUDA
                        cuda_ok = "NVIDIA" in name.upper()
                        gpus.append({
                            "index": len(gpus),
                            "name": name,
                            "type": gpu_type,
                            "vram_mb": vram_mb,
                            "cuda_compatible": cuda_ok,
                        })
        except Exception:
            pass

    # Mark CUDA compatibility
    for g in gpus:
        if "cuda_compatible" not in g:
            g["cuda_compatible"] = "NVIDIA" in g.get("type", "")

    return {"gpus": gpus, "cuda_available": any(g["cuda_compatible"] for g in gpus)}


def _find_bundled_model_dirs():
    """
    Tìm model bundled theo thứ tự ưu tiên:
    1. Cùng thư mục với server.py (backend/models/) — dùng khi chạy dev
    2. resources/backend/models/ — dùng khi đã build thành .exe (electron-builder extraResources)
    Trả về (onnx_dir, codec_dir) hoặc (None, None) nếu không tìm thấy.
    """
    base = Path(__file__).parent

    # Candidate paths (thứ tự ưu tiên)
    candidates = [
        base / "models",                          # dev: backend/models/
        base.parent / "resources" / "backend" / "models",  # built .exe
        base.parent / "models",                   # portable fallback
    ]

    for models_root in candidates:
        engine_dir = models_root / "engine" / "cpu-int8"
        codec_dir = models_root / "codec"
        if (engine_dir / "config.json").exists() and (codec_dir / "moss_audio_tokenizer_decode_full.onnx").exists():
            print(f"[VieNeu] ✅ Bundled model found at: {models_root}", flush=True)
            return str(engine_dir), str(codec_dir)

    print("[VieNeu] ⚠️  No bundled model found — will use LOCALAPPDATA cache or download from HuggingFace.", flush=True)
    return None, None


def get_tts() -> BaseVieneuTTS:
    global _tts, _init_error
    with _tts_lock:
        if _tts is None:
            try:
                # Force CPU when setting is 'cpu' — prevents accidental CUDA use on AMD
                init_kwargs: Dict[str, Any] = {"mode": "v3turbo", "threads": _threads_setting}
                if _device_setting == "cpu":
                    os.environ["CUDA_VISIBLE_DEVICES"] = ""
                    init_kwargs["device"] = "cpu"
                elif _device_setting == "cuda":
                    init_kwargs["device"] = "cuda"
                # For 'auto', let Vieneu decide (original behaviour)

                # --- Ưu tiên model bundled trong project (offline-capable) ---
                onnx_dir, codec_dir = _find_bundled_model_dirs()
                if onnx_dir:
                    init_kwargs["onnx_dir"] = onnx_dir
                    init_kwargs["codec_dir"] = codec_dir

                try:
                    _tts = Vieneu(**init_kwargs)
                except TypeError:
                    # Older SDK that doesn't accept 'device' / 'onnx_dir' kwargs
                    init_kwargs.pop("device", None)
                    init_kwargs.pop("onnx_dir", None)
                    init_kwargs.pop("codec_dir", None)
                    _tts = Vieneu(mode="v3turbo", threads=_threads_setting)
            except Exception as e:
                import traceback
                _init_error = traceback.format_exc()
                print(_init_error, flush=True)
                raise
        return _tts


app = FastAPI(title="VieNeu Studio Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# --- Background Jobs System --------------------------------------------------
class JobState:
    def __init__(self, job_id: str, job_type: str, total_steps: int):
        self.job_id = job_id
        self.job_type = job_type
        self.total_steps = total_steps
        self.current_step = 0
        self.progress = 0.0
        self.status = "running"  # running, paused, completed, failed, cancelled
        self.error = None
        self.start_time = time.time()
        self.elapsed_time = 0.0
        self.eta_seconds = 0.0
        self.file_path = None
        self.partial_file_path = None
        self.completed_count = 0
        self.has_partial = False
        self.meta = {}
        self.chunk_paths: List[str] = []
        self.pause_event = threading.Event()
        self.pause_event.set()
        self.cancel_event = threading.Event()

    def update_progress(self, current_step: int, partial_path: Optional[str] = None):
        self.current_step = current_step
        self.progress = min(max((current_step / self.total_steps) * 100.0 if self.total_steps > 0 else 100.0, 0.0), 100.0)
        self.elapsed_time = time.time() - self.start_time
        if current_step > 0:
            rate = self.elapsed_time / current_step
            remaining_steps = max(self.total_steps - current_step, 0)
            self.eta_seconds = rate * remaining_steps
        else:
            self.eta_seconds = 0.0

        if partial_path:
            self.partial_file_path = partial_path
            self.has_partial = True
            self.completed_count = current_step

    def to_dict(self) -> dict:
        fn = Path(self.file_path).name if self.file_path else None
        pfn = Path(self.partial_file_path).name if self.partial_file_path else None
        return {
            "job_id": self.job_id,
            "job_type": self.job_type,
            "total_steps": self.total_steps,
            "current_step": self.current_step,
            "progress": self.progress,
            "status": self.status,
            "error": self.error,
            "elapsed_time": self.elapsed_time,
            "eta_seconds": self.eta_seconds,
            "file_path": self.file_path,
            "filename": fn,
            "audio_url": f"/audio/{fn}" if fn else None,
            "partial_filename": pfn,
            "partial_audio_url": f"/audio/{pfn}" if pfn else None,
            "has_partial": self.has_partial,
            "completed_count": self.completed_count,
            "chunk_urls": [f"/audio/{Path(p).name}" for p in self.chunk_paths],
            "meta": self.meta,
        }


_jobs: Dict[str, JobState] = {}
_jobs_lock = threading.Lock()


def _get_job(job_id: str) -> JobState:
    with _jobs_lock:
        if job_id not in _jobs:
            raise HTTPException(404, f"Job {job_id} not found")
        return _jobs[job_id]


# --- Helper Audio & Seed Functions -------------------------------------------
def _adjust_audio_speed(audio_path: str, speed: float) -> str:
    """Adjust audio playback speed with pitch preservation via FFmpeg atempo filter."""
    if abs(speed - 1.0) < 0.02:
        return audio_path
    ffmpeg_exe = _get_ffmpeg_exe()
    if not ffmpeg_exe:
        return audio_path
    p = Path(audio_path)
    if not p.exists():
        return audio_path
    out_speed_path = p.parent / f"spd_{p.name}"
    s = max(min(speed, 2.0), 0.5)
    cmd = [ffmpeg_exe, "-y", "-i", str(p), "-filter:a", f"atempo={s}", str(out_speed_path)]
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if res.returncode == 0 and out_speed_path.exists():
        shutil.move(str(out_speed_path), str(p))
    return str(p)


def _save_audio(audio, speed: float = 1.0, sample_rate: int = 48000) -> str:
    file_id = f"{uuid.uuid4().hex}.wav"
    out_path = OUTPUT_DIR / file_id
    if sample_rate == 48000:
        try:
            get_tts().save(audio, str(out_path))
        except Exception:
            import soundfile as sf
            sf.write(str(out_path), audio, samplerate=sample_rate)
    else:
        import soundfile as sf
        sf.write(str(out_path), audio, samplerate=sample_rate)
    if abs(speed - 1.0) >= 0.02:
        _adjust_audio_speed(str(out_path), speed)
    return str(out_path)


# --- Piper ONNX Engine -------------------------------------------------------
_piper_voices: dict = {}
PIPER_CATALOG = [
    # --- Tiếng Việt ---
    {
        "id": "banmai",
        "name": "Ban Mai",
        "desc": "Giọng nữ miền Bắc nhẹ nhàng, chuẩn truyền hình",
        "gender": "nu",
        "region": "bac",
        "region_name": "Miền Bắc (Hà Nội)",
        "accent": "vi_bac",
        "accent_name": "Bắc Bộ",
        "lang": "vi",
        "style": "truyen_cam",
        "hf_files": ["banmai.onnx", "banmai.onnx.json"],
    },
    {
        "id": "ngocngan3701",
        "name": "Nguyễn Ngọc Ngạn",
        "desc": "Giọng nam miền Nam kể chuyện đêm khuya, truyền cảm",
        "gender": "nam",
        "region": "nam",
        "region_name": "Miền Nam (Sài Gòn)",
        "accent": "vi_nam",
        "accent_name": "Nam Bộ",
        "lang": "vi",
        "style": "ke_chuyen",
        "hf_files": ["ngocngan3701.onnx", "ngocngan3701.onnx.json"],
    },
    {
        "id": "lacphi",
        "name": "Lạc Phi",
        "desc": "Giọng nam miền Bắc đọc truyện thanh, sách nói",
        "gender": "nam",
        "region": "bac",
        "region_name": "Miền Bắc (Hà Nội)",
        "accent": "vi_bac",
        "accent_name": "Bắc Bộ",
        "lang": "vi",
        "style": "truyen_thanh",
        "hf_files": ["lacphi.onnx", "lacphi.onnx.json"],
    },
    {
        "id": "maiphuong",
        "name": "Mai Phương",
        "desc": "Giọng nữ miền Nam trẻ trung, tự nhiên",
        "gender": "nu",
        "region": "nam",
        "region_name": "Miền Nam (Sài Gòn)",
        "accent": "vi_nam",
        "accent_name": "Nam Bộ",
        "lang": "vi",
        "style": "tu_nhien",
        "hf_files": ["maiphuong.onnx", "maiphuong.onnx.json"],
    },
    {
        "id": "manhdung",
        "name": "Mạnh Dũng",
        "desc": "Giọng nam miền Bắc trầm ấm, đọc tin tức",
        "gender": "nam",
        "region": "bac",
        "region_name": "Miền Bắc (Hà Nội)",
        "accent": "vi_bac",
        "accent_name": "Bắc Bộ",
        "lang": "vi",
        "style": "tin_tuc",
        "hf_files": ["manhdung.onnx", "manhdung.onnx.json"],
    },
    {
        "id": "minhkhang",
        "name": "Minh Khang",
        "desc": "Giọng nam miền Bắc khỏe khoắn, đọc quảng cáo",
        "gender": "nam",
        "region": "bac",
        "region_name": "Miền Bắc (Hà Nội)",
        "accent": "vi_bac",
        "accent_name": "Bắc Bộ",
        "lang": "vi",
        "style": "quang_cao",
        "hf_files": ["minhkhang.onnx", "minhkhang.onnx.json"],
    },
    {
        "id": "minhquang",
        "name": "Minh Quang",
        "desc": "Giọng nam miền Bắc kể chuyện, đọc tiểu thuyết",
        "gender": "nam",
        "region": "bac",
        "region_name": "Miền Bắc (Hà Nội)",
        "accent": "vi_bac",
        "accent_name": "Bắc Bộ",
        "lang": "vi",
        "style": "ke_chuyen",
        "hf_files": ["minhquang.onnx", "minhquang.onnx.json"],
    },
    {
        "id": "ngochuyen",
        "name": "Ngọc Huyền",
        "desc": "Giọng nữ miền Nam ngọt ngào, dịu dàng",
        "gender": "nu",
        "region": "nam",
        "region_name": "Miền Nam (Sài Gòn)",
        "accent": "vi_nam",
        "accent_name": "Nam Bộ",
        "lang": "vi",
        "style": "diu_dang",
        "hf_files": ["ngochuyen.onnx", "ngochuyen.onnx.json"],
    },
    {
        "id": "phuongtrang",
        "name": "Phương Trang",
        "desc": "Giọng nữ miền Bắc trẻ trung, tự nhiên",
        "gender": "nu",
        "region": "bac",
        "region_name": "Miền Bắc (Hà Nội)",
        "accent": "vi_bac",
        "accent_name": "Bắc Bộ",
        "lang": "vi",
        "style": "tu_nhien",
        "hf_files": ["phuongtrang.onnx", "phuongtrang.onnx.json"],
    },
    {
        "id": "taian4",
        "name": "Tài An",
        "desc": "Giọng nam trầm, mạnh mẽ",
        "gender": "nam",
        "region": "bac",
        "region_name": "Miền Bắc (Hà Nội)",
        "accent": "vi_bac",
        "accent_name": "Bắc Bộ",
        "lang": "vi",
        "style": "manh_me",
        "hf_files": ["taian4.onnx", "taian4.onnx.json"],
    },
    {
        "id": "thanhphuong2",
        "name": "Thanh Phương",
        "desc": "Giọng nữ miền Nam nhẹ nhàng, thanh thoát",
        "gender": "nu",
        "region": "nam",
        "region_name": "Miền Nam (Sài Gòn)",
        "accent": "vi_nam",
        "accent_name": "Nam Bộ",
        "lang": "vi",
        "style": "nhe_nhang",
        "hf_files": ["thanhphuong2.onnx", "thanhphuong2.onnx.json"],
    },
    {
        "id": "thientam",
        "name": "Thiện Tâm",
        "desc": "Giọng đọc kinh Phật, triết lý, sách nói sâu lắng",
        "gender": "nam",
        "region": "bac",
        "region_name": "Miền Bắc (Hà Nội)",
        "accent": "vi_bac",
        "accent_name": "Bắc Bộ",
        "lang": "vi",
        "style": "sau_lang",
        "hf_files": ["thientam.onnx", "thientam.onnx.json"],
    },
    {
        "id": "chieuthanh",
        "name": "Chiêu Thành",
        "desc": "Giọng nam miền Nam ấm áp",
        "gender": "nam",
        "region": "nam",
        "region_name": "Miền Nam (Sài Gòn)",
        "accent": "vi_nam",
        "accent_name": "Nam Bộ",
        "lang": "vi",
        "style": "tram_am",
        "hf_files": ["chieuthanh.onnx", "chieuthanh.onnx.json"],
    },
    {
        "id": "vi_VN-vais1000-medium",
        "name": "Vais1000 Chuẩn",
        "desc": "Giọng đọc chuẩn tiếng Việt cơ bản",
        "gender": "nu",
        "region": "bac",
        "region_name": "Miền Bắc (Chuẩn)",
        "accent": "vi_bac",
        "accent_name": "Bắc Bộ",
        "lang": "vi",
        "style": "tin_tuc",
        "hf_files": ["vi_VN-vais1000-medium.onnx", "vi_VN-vais1000-medium.onnx.json"],
    },
    {
        "id": "duyoryx3175",
        "name": "Duy Oryx",
        "desc": "Giọng nam miền Bắc khỏe khoắn, đọc tin tức",
        "gender": "nam",
        "region": "bac",
        "region_name": "Miền Bắc (Hà Nội)",
        "accent": "vi_bac",
        "accent_name": "Bắc Bộ",
        "lang": "vi",
        "style": "tin_tuc",
        "hf_files": ["duyoryx3175.onnx", "duyoryx3175.onnx.json"],
    },

    # --- Tiếng Anh: Bắc Mỹ (General US / West / Midwest) ---
    {
        "id": "en_US-lessac-medium",
        "name": "Lessac (Nữ Bắc Mỹ)",
        "desc": "Giọng nữ bản xứ Bắc Mỹ (General American) chuẩn, rõ ràng",
        "gender": "nu",
        "region": "us_bacmy",
        "region_name": "Bắc Mỹ (General US)",
        "accent": "us_general",
        "accent_name": "Bắc Mỹ",
        "lang": "en",
        "style": "tin_tuc",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/",
        "hf_files": ["en_US-lessac-medium.onnx", "en_US-lessac-medium.onnx.json"],
    },
    {
        "id": "en_US-amy-medium",
        "name": "Amy (Nữ Bắc Mỹ)",
        "desc": "Giọng nữ Bắc Mỹ (Midwest US) ấm áp, đọc truyện và podcast",
        "gender": "nu",
        "region": "us_bacmy",
        "region_name": "Bắc Mỹ (Midwest US)",
        "accent": "us_general",
        "accent_name": "Bắc Mỹ",
        "lang": "en",
        "style": "ke_chuyen",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/",
        "hf_files": ["en_US-amy-medium.onnx", "en_US-amy-medium.onnx.json"],
    },
    {
        "id": "en_US-ryan-medium",
        "name": "Ryan (Nam Bắc Mỹ)",
        "desc": "Giọng nam Bắc Mỹ (General US) tự nhiên, hiện đại",
        "gender": "nam",
        "region": "us_bacmy",
        "region_name": "Bắc Mỹ (General US)",
        "accent": "us_general",
        "accent_name": "Bắc Mỹ",
        "lang": "en",
        "style": "quang_cao",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/",
        "hf_files": ["en_US-ryan-medium.onnx", "en_US-ryan-medium.onnx.json"],
    },
    {
        "id": "en_US-joe-medium",
        "name": "Joe (Nam Bắc Mỹ)",
        "desc": "Giọng nam Bắc Mỹ trầm ấm, giọng đọc phát thanh",
        "gender": "nam",
        "region": "us_bacmy",
        "region_name": "Bắc Mỹ (Broadcast)",
        "accent": "us_general",
        "accent_name": "Bắc Mỹ",
        "lang": "en",
        "style": "truyen_cam",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/",
        "hf_files": ["en_US-joe-medium.onnx", "en_US-joe-medium.onnx.json"],
    },
    {
        "id": "en_US-bryce-medium",
        "name": "Bryce (Nam Bờ Tây Mỹ)",
        "desc": "Giọng nam bờ Tây Hoa Kỳ (California style) trẻ trung",
        "gender": "nam",
        "region": "us_bacmy",
        "region_name": "Bắc Mỹ (Bờ Tây / West Coast)",
        "accent": "us_general",
        "accent_name": "Bắc Mỹ",
        "lang": "en",
        "style": "tu_nhien",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/bryce/medium/",
        "hf_files": ["en_US-bryce-medium.onnx", "en_US-bryce-medium.onnx.json"],
    },
    {
        "id": "en_US-kristin-medium",
        "name": "Kristin (Nữ Bắc Mỹ)",
        "desc": "Giọng nữ Bắc Mỹ truyền cảm, phù hợp đọc sách nói",
        "gender": "nu",
        "region": "us_bacmy",
        "region_name": "Bắc Mỹ (Standard US)",
        "accent": "us_general",
        "accent_name": "Bắc Mỹ",
        "lang": "en",
        "style": "sach_noi",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kristin/medium/",
        "hf_files": ["en_US-kristin-medium.onnx", "en_US-kristin-medium.onnx.json"],
    },
    {
        "id": "en_US-ljspeech-high",
        "name": "LJSpeech (Nữ AudioBook)",
        "desc": "Giọng đọc sách nói nổi tiếng nước Mỹ, chất lượng cực cao",
        "gender": "nu",
        "region": "us_bacmy",
        "region_name": "Bắc Mỹ (AudioBook)",
        "accent": "us_general",
        "accent_name": "Bắc Mỹ",
        "lang": "en",
        "style": "sach_noi",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/high/",
        "hf_files": ["en_US-ljspeech-high.onnx", "en_US-ljspeech-high.onnx.json"],
    },

    # --- Tiếng Anh: New York / Bờ Đông Mỹ ---
    {
        "id": "en_US-norman-medium",
        "name": "Norman (Nam New York)",
        "desc": "Giọng nam phong cách New York / Đông Bắc Hoa Kỳ",
        "gender": "nam",
        "region": "us_newyork",
        "region_name": "New York / Bờ Đông Mỹ",
        "accent": "us_ny",
        "accent_name": "New York",
        "lang": "en",
        "style": "tu_nhien",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/norman/medium/",
        "hf_files": ["en_US-norman-medium.onnx", "en_US-norman-medium.onnx.json"],
    },

    # --- Tiếng Anh: Nam Mỹ (US Southern Accent) ---
    {
        "id": "en_US-danny-low",
        "name": "Danny (Nam Miền Nam Hoa Kỳ)",
        "desc": "Giọng nam đặc trưng vùng Nam Mỹ (US Southern Drawl Accent)",
        "gender": "nam",
        "region": "us_nammy",
        "region_name": "Miền Nam Hoa Kỳ (US South)",
        "accent": "us_southern",
        "accent_name": "Nam Mỹ (US South)",
        "lang": "en",
        "style": "tu_nhien",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/danny/low/",
        "hf_files": ["en_US-danny-low.onnx", "en_US-danny-low.onnx.json"],
    },

    # --- Tiếng Anh: Anh Quốc (British / UK / Scotland) ---
    {
        "id": "en_GB-alan-medium",
        "name": "Alan (Nam Anh Quốc)",
        "desc": "Giọng nam Anh Quốc phát âm chuẩn British RP",
        "gender": "nam",
        "region": "uk",
        "region_name": "Anh Quốc (British RP)",
        "accent": "uk_rp",
        "accent_name": "Anh Quốc (UK)",
        "lang": "en",
        "style": "tin_tuc",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/",
        "hf_files": ["en_GB-alan-medium.onnx", "en_GB-alan-medium.onnx.json"],
    },
    {
        "id": "en_GB-cori-high",
        "name": "Cori (Nữ Oxford UK)",
        "desc": "Giọng nữ quý phái chuẩn Oxford British, độ chi tiết cao",
        "gender": "nu",
        "region": "uk",
        "region_name": "Anh Quốc (Oxford British)",
        "accent": "uk_rp",
        "accent_name": "Anh Quốc (UK)",
        "lang": "en",
        "style": "truyen_cam",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/high/",
        "hf_files": ["en_GB-cori-high.onnx", "en_GB-cori-high.onnx.json"],
    },
    {
        "id": "en_GB-alba-medium",
        "name": "Alba (Nữ Scotland)",
        "desc": "Giọng nữ Scotland (Bắc Anh) nhẹ nhàng, độc đáo",
        "gender": "nu",
        "region": "uk_scot",
        "region_name": "Scotland (Bắc Anh)",
        "accent": "uk_scot",
        "accent_name": "Scotland",
        "lang": "en",
        "style": "ke_chuyen",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/",
        "hf_files": ["en_GB-alba-medium.onnx", "en_GB-alba-medium.onnx.json"],
    },
    {
        "id": "en_GB-jenny_dioco-medium",
        "name": "Jenny (Nữ Anh Hiện Đại)",
        "desc": "Giọng nữ Anh Quốc hiện đại, tự nhiên và trẻ trung",
        "gender": "nu",
        "region": "uk",
        "region_name": "Anh Quốc (Modern British)",
        "accent": "uk_rp",
        "accent_name": "Anh Quốc (UK)",
        "lang": "en",
        "style": "tu_nhien",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jenny_dioco/medium/",
        "hf_files": ["en_GB-jenny_dioco-medium.onnx", "en_GB-jenny_dioco-medium.onnx.json"],
    },
    {
        "id": "en_US-john-medium",
        "name": "John (Nam Bắc Mỹ)",
        "desc": "Giọng nam Bắc Mỹ trầm ấm, giọng đọc tài liệu",
        "gender": "nam",
        "region": "us_bacmy",
        "region_name": "Bắc Mỹ (Documentary)",
        "accent": "us_general",
        "accent_name": "Bắc Mỹ",
        "lang": "en",
        "style": "tram_am",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/john/medium/",
        "hf_files": ["en_US-john-medium.onnx", "en_US-john-medium.onnx.json"],
    },
    {
        "id": "en_US-sam-medium",
        "name": "Sam (Nam Bắc Mỹ)",
        "desc": "Giọng nam Bắc Mỹ tự nhiên, đọc sách và hội thoại",
        "gender": "nam",
        "region": "us_bacmy",
        "region_name": "Bắc Mỹ (Casual)",
        "accent": "us_general",
        "accent_name": "Bắc Mỹ",
        "lang": "en",
        "style": "tu_nhien",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/sam/medium/",
        "hf_files": ["en_US-sam-medium.onnx", "en_US-sam-medium.onnx.json"],
    },
    {
        "id": "en_US-hfc_female-medium",
        "name": "HFC Female (Nữ Bắc Mỹ)",
        "desc": "Giọng nữ Bắc Mỹ trong trẻo, chuyên nghiệp",
        "gender": "nu",
        "region": "us_bacmy",
        "region_name": "Bắc Mỹ (Professional)",
        "accent": "us_general",
        "accent_name": "Bắc Mỹ",
        "lang": "en",
        "style": "tin_tuc",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/hfc_female/medium/",
        "hf_files": ["en_US-hfc_female-medium.onnx", "en_US-hfc_female-medium.onnx.json"],
    },
    {
        "id": "en_GB-northern_english_male-medium",
        "name": "Northern Male (Nam Bắc Anh)",
        "desc": "Giọng nam đặc trưng vùng Bắc Anh / Yorkshire",
        "gender": "nam",
        "region": "uk_north",
        "region_name": "Bắc Anh (Yorkshire UK)",
        "accent": "uk_north",
        "accent_name": "Bắc Anh",
        "lang": "en",
        "style": "tu_nhien",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/northern_english_male/medium/",
        "hf_files": ["en_GB-northern_english_male-medium.onnx", "en_GB-northern_english_male-medium.onnx.json"],
    },
    {
        "id": "fr_FR-siwis-medium",
        "name": "Siwis (Nữ Pháp 🇫🇷)",
        "desc": "Giọng nữ tiếng Pháp chuẩn Paris, thanh lịch",
        "gender": "nu",
        "region": "fr",
        "region_name": "Pháp (Paris 🇫🇷)",
        "accent": "fr",
        "accent_name": "Tiếng Pháp",
        "lang": "fr",
        "style": "tu_nhien",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/",
        "hf_files": ["fr_FR-siwis-medium.onnx", "fr_FR-siwis-medium.onnx.json"],
    },
    {
        "id": "de_DE-thorsten-medium",
        "name": "Thorsten (Nam Đức 🇩🇪)",
        "desc": "Giọng nam tiếng Đức trầm ấm, tự nhiên",
        "gender": "nam",
        "region": "de",
        "region_name": "Đức (Berlin 🇩🇪)",
        "accent": "de",
        "accent_name": "Tiếng Đức",
        "lang": "de",
        "style": "tram_am",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium/",
        "hf_files": ["de_DE-thorsten-medium.onnx", "de_DE-thorsten-medium.onnx.json"],
    },
    {
        "id": "es_ES-davefx-medium",
        "name": "Davefx (Nam Tây Ban Nha 🇪🇸)",
        "desc": "Giọng nam tiếng Tây Ban Nha chuẩn Castilian",
        "gender": "nam",
        "region": "es",
        "region_name": "Tây Ban Nha (Madrid 🇪🇸)",
        "accent": "es",
        "accent_name": "Tiếng Tây Ban Nha",
        "lang": "es",
        "style": "tin_tuc",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium/",
        "hf_files": ["es_ES-davefx-medium.onnx", "es_ES-davefx-medium.onnx.json"],
    },
    {
        "id": "es_ES-sharvard-medium",
        "name": "Sharvard (Nữ Tây Ban Nha 🇪🇸)",
        "desc": "Giọng nữ tiếng Tây Ban Nha nhẹ nhàng, truyền cảm",
        "gender": "nu",
        "region": "es",
        "region_name": "Tây Ban Nha (Castilian 🇪🇸)",
        "accent": "es",
        "accent_name": "Tiếng Tây Ban Nha",
        "lang": "es",
        "style": "truyen_cam",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/sharvard/medium/",
        "hf_files": ["es_ES-sharvard-medium.onnx", "es_ES-sharvard-medium.onnx.json"],
    },
    {
        "id": "it_IT-paola-medium",
        "name": "Paola (Nữ Ý 🇮🇹)",
        "desc": "Giọng nữ tiếng Ý ngọt ngào, chuẩn Rome",
        "gender": "nu",
        "region": "it",
        "region_name": "Ý (Rome 🇮🇹)",
        "accent": "it",
        "accent_name": "Tiếng Ý",
        "lang": "it",
        "style": "truyen_cam",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium/",
        "hf_files": ["it_IT-paola-medium.onnx", "it_IT-paola-medium.onnx.json"],
    },
    {
        "id": "it_IT-serena-medium",
        "name": "Serena (Nữ Ý 🇮🇹)",
        "desc": "Giọng nữ tiếng Ý tự nhiên, rõ ràng",
        "gender": "nu",
        "region": "it",
        "region_name": "Ý (Milan 🇮🇹)",
        "accent": "it",
        "accent_name": "Tiếng Ý",
        "lang": "it",
        "style": "tin_tuc",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/serena/medium/",
        "hf_files": ["it_IT-serena-medium.onnx", "it_IT-serena-medium.onnx.json"],
    },
    {
        "id": "ja_JA-hi_fi_captain-medium",
        "name": "Hi-Fi Captain (Nam Nhật Bản 🇯🇵)",
        "desc": "Giọng nam tiếng Nhật chuẩn Tokyo, truyền cảm",
        "gender": "nam",
        "region": "ja",
        "region_name": "Nhật Bản (Tokyo 🇯🇵)",
        "accent": "ja",
        "accent_name": "Tiếng Nhật",
        "lang": "ja",
        "style": "ke_chuyen",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/ja/ja_JA/hi_fi_captain/medium/",
        "hf_files": ["ja_JA-hi_fi_captain-medium.onnx", "ja_JA-hi_fi_captain-medium.onnx.json"],
    },
    {
        "id": "ko_KR-kss-medium",
        "name": "KSS (Nữ Hàn Quốc 🇰🇷)",
        "desc": "Giọng nữ tiếng Hàn chuẩn Seoul, tự nhiên",
        "gender": "nu",
        "region": "ko",
        "region_name": "Hàn Quốc (Seoul 🇰🇷)",
        "accent": "ko",
        "accent_name": "Tiếng Hàn",
        "lang": "ko",
        "style": "tin_tuc",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/ko/ko_KR/kss/medium/",
        "hf_files": ["ko_KR-kss-medium.onnx", "ko_KR-kss-medium.onnx.json"],
    },
    {
        "id": "zh_CN-huayan-medium",
        "name": "Huayan (Nữ Trung Quốc 🇨🇳)",
        "desc": "Giọng nữ tiếng Trung Quốc phổ thông (Mandarin)",
        "gender": "nu",
        "region": "zh",
        "region_name": "Trung Quốc (Bắc Kinh 🇨🇳)",
        "accent": "zh",
        "accent_name": "Tiếng Trung",
        "lang": "zh",
        "style": "tin_tuc",
        "hf_base": "https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/",
        "hf_files": ["zh_CN-huayan-medium.onnx", "zh_CN-huayan-medium.onnx.json"],
    },
]


def _get_piper_voice(model_name: str):
    if model_name in _piper_voices:
        return _piper_voices[model_name]
    model_path = PIPER_MODELS_DIR / f"{model_name}.onnx"
    if not model_path.exists():
        for f in PIPER_MODELS_DIR.glob("*.onnx"):
            if f.stem == model_name or f.name == model_name:
                model_path = f
                break
    if not model_path.exists():
        raise FileNotFoundError(f"Không tìm thấy model ONNX: {model_name} trong thư mục piper_models")
    from piper import PiperVoice
    pv = PiperVoice.load(str(model_path))
    _piper_voices[model_name] = pv
    return pv


def _infer_piper(voice_id: str, text: str) -> tuple:
    """Run inference with Piper ONNX voice. Returns (audio_array_float32, sample_rate)."""
    import io
    import wave
    import soundfile as sf
    model_name = voice_id.replace("piper:", "").strip()
    pv = _get_piper_voice(model_name)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav_file:
        pv.synthesize_wav(text, wav_file, set_wav_format=True)
    buf.seek(0)
    data, sr = sf.read(buf, dtype='float32')
    return data, sr


def _list_installed_piper_models() -> List[dict]:
    installed = []
    for onnx_file in PIPER_MODELS_DIR.glob("*.onnx"):
        stem = onnx_file.stem
        cat_info = next((c for c in PIPER_CATALOG if c["id"] == stem), None)
        size_mb = round(onnx_file.stat().st_size / (1024 * 1024), 1)

        name = cat_info["name"] if cat_info else stem
        gender = cat_info.get("gender", "chua_ro") if cat_info else "chua_ro"
        gender_str = "Nữ" if gender == "nu" else ("Nam" if gender == "nam" else "")
        region = cat_info.get("region", "chua_ro") if cat_info else "chua_ro"
        region_name = cat_info.get("region_name") or cat_info.get("accent_name") or ""
        accent_name = cat_info.get("accent_name", "") if cat_info else ""
        lang = cat_info.get("lang", "vi") if cat_info else ("en" if stem.startswith("en_") else "vi")
        style = cat_info.get("style", "") if cat_info else ""

        # Build readable tags: e.g. "⚡ Nguyễn Ngọc Ngạn [Nam · Nam Bộ · Sài Gòn]"
        tags = []
        if gender_str:
            tags.append(gender_str)
        if region_name and region_name != "chua_ro":
            tags.append(region_name)
        elif accent_name:
            tags.append(accent_name)

        tag_str = f" [{ ' · '.join(tags) }]" if tags else " [ONNX]"
        icon = "🗣️" if lang == "en" or str(region).startswith("us") or str(region).startswith("uk") else "⚡"

        installed.append({
            "id": f"piper:{stem}",
            "stem": stem,
            "label": f"{icon} {name}{tag_str}",
            "name": name,
            "desc": cat_info["desc"] if cat_info else f"Model ONNX {stem}",
            "gender": gender,
            "region": region,
            "region_name": region_name,
            "accent_name": accent_name,
            "lang": lang,
            "style": style,
            "engine": "piper",
            "size_mb": size_mb,
        })
    return installed


def _auto_download_catalog_voices():
    """Background worker that automatically downloads missing catalog ONNX voices on startup."""
    import time
    import urllib.request
    time.sleep(2)
    for cat_item in PIPER_CATALOG:
        try:
            base_url = cat_item.get("hf_base") or "https://huggingface.co/hoanglinhn0/Model/resolve/main/"
            for fname in cat_item["hf_files"]:
                target = PIPER_MODELS_DIR / fname
                if not target.exists():
                    url = f"{base_url}{fname}"
                    req_obj = urllib.request.Request(url, headers={"User-Agent": "VieNeu-Studio/1.0"})
                    with urllib.request.urlopen(req_obj, timeout=120) as resp, open(target, "wb") as f:
                        shutil.copyfileobj(resp, f)
            _piper_voices.pop(cat_item["id"], None)
        except Exception as e:
            print(f"[AutoDownload] Error downloading {cat_item.get('id')}: {e}")

threading.Thread(target=_auto_download_catalog_voices, daemon=True).start()


def _b64_to_temp_wav(b64_data: str) -> str:
    raw = base64.b64decode(b64_data)
    tmp = OUTPUT_DIR / f"ref_{uuid.uuid4().hex}.wav"
    tmp.write_bytes(raw)
    return str(tmp)


def _pin_seed(seed: Optional[int]) -> int:
    import random
    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    random.seed(seed)
    try:
        import numpy as np
        np.random.seed(seed)
    except Exception:
        pass
    try:
        # pyrefly: ignore [missing-import]
        import torch
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except Exception:
        pass
    try:
        # pyrefly: ignore [missing-import]
        import onnxruntime as ort
        ort.set_seed(seed)
    except Exception:
        pass
    return seed


def _speaker_seed(name: str) -> int:
    return int(hashlib.sha256(name.encode("utf-8")).hexdigest()[:8], 16)


# --- System & Settings Routes ------------------------------------------------
@app.get("/system/cpu-info")
def cpu_info():
    logical = os.cpu_count() or 8
    physical = None
    try:
        import psutil
        physical = psutil.cpu_count(logical=False)
    except Exception:
        pass
    if not physical:
        try:
            if platform.system() == "Linux":
                with open("/proc/cpuinfo") as f:
                    text = f.read()
                core_ids = set()
                phys_id, core_id = None, None
                for line in text.splitlines():
                    if line.startswith("physical id"):
                        phys_id = line.split(":")[1].strip()
                    elif line.startswith("core id"):
                        core_id = line.split(":")[1].strip()
                        if phys_id is not None:
                            core_ids.add((phys_id, core_id))
                if core_ids:
                    physical = len(core_ids)
            elif platform.system() == "Windows":
                out = subprocess.check_output(
                    ["wmic", "cpu", "get", "NumberOfCores"], text=True, timeout=3
                )
                nums = [int(x) for x in out.split() if x.strip().isdigit()]
                if nums:
                    physical = sum(nums)
            elif platform.system() == "Darwin":
                out = subprocess.check_output(
                    ["sysctl", "-n", "hw.physicalcpu"], text=True, timeout=3
                )
                physical = int(out.strip())
        except Exception:
            pass
    return {
        "logical_cores": logical,
        "physical_cores": physical or logical,
        "platform": platform.system(),
    }


@app.get("/system/ffmpeg-status")
def ffmpeg_status():
    exe = _get_ffmpeg_exe()
    return {
        "available": exe is not None,
        "path": exe or "",
    }


@app.get("/system/gpu-info")
def gpu_info():
    """Detect all GPUs on the system and report CUDA compatibility."""
    return _detect_gpu_info()


class ThreadSettingsRequest(BaseModel):
    threads: int


class DeviceSettingsRequest(BaseModel):
    device: str  # "cpu", "cuda", or "auto"


@app.get("/settings/threads")
def get_thread_setting():
    return {
        "threads": _threads_setting,
        "logical_cores": _cpu_thread_ceiling(),
        "engine_loaded": _tts is not None,
    }


@app.post("/settings/threads")
def set_thread_setting(req: ThreadSettingsRequest):
    global _threads_setting, _tts
    ceiling = _cpu_thread_ceiling()
    if req.threads < 0 or req.threads > ceiling:
        raise HTTPException(400, f"threads must be between 0 (auto) and {ceiling}")
    if req.threads != _threads_setting:
        # Unload engine cũ và lưu giá trị mới
        with _tts_lock:
            _threads_setting = req.threads
            _tts = None
        # Reload engine ngay lập tức trên background thread (không block API)
        captured_threads = req.threads
        def _reload_engine():
            try:
                get_tts()
                print(f"[VieNeu] ✅ Engine reloaded immediately with threads={captured_threads}", flush=True)
            except Exception as e:
                print(f"[VieNeu] ⚠️  Engine reload failed: {e}", flush=True)
        threading.Thread(target=_reload_engine, daemon=True, name="tts-reload").start()
    return {"threads": _threads_setting, "reload_pending": False}



@app.get("/settings/device")
def get_device_setting():
    backend_type = getattr(_tts, "backend", "onnx") if _tts else "onnx"
    actual = "CPU (ONNX Runtime)" if _device_setting == "cpu" or backend_type == "onnx" else "GPU (CUDA)"
    return {
        "device": _device_setting,
        "backend": backend_type,
        "actual_runtime": actual,
        "engine_loaded": _tts is not None,
    }


@app.post("/settings/device")
def set_device_setting(req: DeviceSettingsRequest):
    global _device_setting, _tts
    if req.device not in ("cpu", "cuda", "auto"):
        raise HTTPException(400, "device must be 'cpu', 'cuda', or 'auto'")
    if req.device != _device_setting:
        _device_setting = req.device
        _tts = None  # Force engine reload on next request
        # Apply CUDA_VISIBLE_DEVICES immediately
        if req.device == "cpu":
            os.environ["CUDA_VISIBLE_DEVICES"] = ""
        else:
            os.environ.pop("CUDA_VISIBLE_DEVICES", None)
    return {"device": _device_setting, "reload_pending": _tts is None}


class BenchmarkRequest(BaseModel):
    text: str = "Xin chào, đây là bài kiểm tra tốc độ tạo giọng nói."
    voice: Optional[str] = None


@app.post("/system/benchmark")
def run_benchmark(req: BenchmarkRequest):
    """Run a quick synthesis benchmark to measure generation speed."""
    import time
    text = (req.text or "Xin chào, đây là bài kiểm tra tốc độ tạo giọng nói.").strip()
    char_count = len(text)

    t0 = time.perf_counter()
    try:
        # Always use the main VieNeu TTS engine for the benchmark
        # (Piper voices are excluded here because this measures the primary engine speed)
        tts = get_tts()
        _pin_seed(42)
        # Only pass voice if it's a real VieNeu voice (not piper/custom prefix)
        voice_id = req.voice
        is_external = voice_id and (voice_id.startswith("piper:") or voice_id.startswith("piper_") or voice_id.startswith("custom:") or voice_id.startswith("custom_"))
        valid_voice = voice_id if (voice_id and not is_external) else None
        if valid_voice:
            try:
                audio = tts.infer(text=text, voice=valid_voice)
            except Exception:
                audio = tts.infer(text=text)
        else:
            audio = tts.infer(text=text)
        elapsed = time.perf_counter() - t0
        sr = getattr(tts, "sample_rate", 48000)
        import numpy as np
        audio_arr = np.asarray(audio)
        audio_duration_s = len(audio_arr) / sr
    except Exception as e:
        raise HTTPException(500, f"Benchmark failed: {e}")

    rtf = round(audio_duration_s / elapsed, 2) if (audio_duration_s and elapsed > 0) else None
    return {
        "device": _device_setting,
        "threads": _threads_setting,
        "text_chars": char_count,
        "inference_time_s": round(elapsed, 3),
        "audio_duration_s": round(audio_duration_s, 3) if audio_duration_s else None,
        "realtime_factor": rtf,
    }


# --- Schemas -----------------------------------------------------------------
class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    ref_audio_b64: Optional[str] = None
    ref_text: Optional[str] = None
    seed: Optional[int] = None
    temperature: Optional[float] = None
    speed: Optional[float] = 1.0


class ConversationLine(BaseModel):
    speaker: str
    text: str


class ConversationRequest(BaseModel):
    lines: List[ConversationLine]
    speaker_voices: dict


class StoryParseRequest(BaseModel):
    text: str


class StoryGenerateRequest(BaseModel):
    text: str
    narrator_voice: str
    character_voices: dict = {}
    gap_ms: int = 350


class DubSrtParseRequest(BaseModel):
    srt_text: str
    voice: Optional[str] = None


class DubSrtGenerateRequest(BaseModel):
    srt_text: str
    voice: str


class DubAudioGenerateRequest(BaseModel):
    audio_b64: str
    voice: str
    language: str = "vi"


class VideoMuxRequest(BaseModel):
    video_b64: str
    audio_filename: str
    mode: str = "replace"  # "replace" or "mix"
    original_volume: float = 0.2
    dub_volume: float = 1.0
    burn_subtitles: bool = False
    srt_text: Optional[str] = None


class BenchmarkRequest(BaseModel):
    engine: str = "vieneu"  # "vieneu" or "piper"
    sample_type: str = "standard"  # "short", "standard", "long"
    voice: Optional[str] = None


BENCHMARK_SAMPLES = {
    "short": "Xin chào! Đây là câu kiểm tra tốc độ ngắn.",
    "standard": "VieNeu Studio là phần mềm tạo giọng nói tiếng Việt chất lượng cao 48kHz chạy hoàn toàn cục bộ trên máy tính.",
    "long": "Trí tuệ nhân tạo đang ngày càng phát triển mạnh mẽ và giúp con người tối ưu hóa quy trình làm việc. Với VieNeu Studio, bạn có thể chuyển đổi bất kỳ văn bản nào thành giọng đọc tự nhiên và truyền cảm chỉ trong vài giây mà không cần kết nối mạng."
}


# --- Core Routes -------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/ready")
def ready():
    try:
        get_tts()
        return {"ready": True}
    except Exception as e:
        raise HTTPException(500, f"Model failed to load: {e}\n\n{_init_error or ''}")


@app.post("/benchmark/run")
def run_speed_benchmark(req: BenchmarkRequest):
    text = BENCHMARK_SAMPLES.get(req.sample_type, BENCHMARK_SAMPLES["standard"])
    t0 = time.perf_counter()

    try:
        if req.engine == "piper":
            installed = _list_installed_piper_models()
            voice_id = req.voice or (installed[0]["id"] if installed else "piper:banmai")
            audio, sr = _infer_piper(voice_id, text)
            duration_s = round(len(audio) / sr, 2)
            temp_filename = f"bench_piper_{int(time.time())}.wav"
            temp_path = OUTPUT_DIR / temp_filename
            import soundfile as sf
            sf.write(str(temp_path), audio, samplerate=sr)
        else:
            tts = get_tts()
            voice_id = req.voice or "Minh Đức"
            _pin_seed(12345)
            audio = tts.infer(text=text, voice=voice_id)
            sr = 48000
            import numpy as np
            if hasattr(audio, "shape"):
                duration_s = round(audio.shape[-1] / sr, 2)
            elif isinstance(audio, (list, np.ndarray)):
                duration_s = round(len(audio) / sr, 2)
            else:
                duration_s = 4.0
            temp_filename = f"bench_vieneu_{int(time.time())}.wav"
            temp_path = OUTPUT_DIR / temp_filename
            tts.save(audio, str(temp_path))

        t1 = time.perf_counter()
        elapsed_s = max(0.001, round(t1 - t0, 3))
        speed_factor = round(duration_s / elapsed_s, 2) if elapsed_s > 0 else 1.0
        chars_per_sec = round(len(text) / elapsed_s, 1)

        return {
            "engine": req.engine,
            "engine_label": "VieNeu 48kHz Turbo" if req.engine == "vieneu" else "Piper ONNX",
            "voice": voice_id,
            "sample_type": req.sample_type,
            "text": text,
            "char_count": len(text),
            "elapsed_seconds": elapsed_s,
            "audio_duration_seconds": duration_s,
            "speed_factor": speed_factor,
            "chars_per_second": chars_per_sec,
            "threads": _threads_setting,
            "device": _device_setting,
            "audio_url": f"/audio/{temp_filename}"
        }
    except Exception as e:
        raise HTTPException(500, f"Lỗi khi đo tốc độ: {e}")


@app.get("/voices")
def list_voices():
    try:
        tts = get_tts()
        raw = tts.list_preset_voices()
        meta = _load_voice_meta()
        out = []
        for label, vid in raw:
            short_name = label.split("—")[0].split("-")[0].strip() if isinstance(label, str) else str(vid)
            m = meta.get(vid) or meta.get(label) or meta.get(short_name) or {}
            
            # Determine gender
            gender = m.get("gender")
            if not gender or gender == "chua_ro":
                if "Nữ" in label:
                    gender = "nu"
                elif "Nam" in label:
                    gender = "nam"
                else:
                    gender = "chua_ro"

            # Determine region
            region = m.get("region")
            if not region or region == "chua_ro":
                if "Bắc" in label or "Hà Nội" in label:
                    region = "bac"
                elif "Trung" in label or "Huế" in label or "Đà Nẵng" in label:
                    region = "trung"
                elif "Nam" in label or "Sài Gòn" in label:
                    region = "nam"
                else:
                    region = "chua_ro"

            gender_str = "Nữ" if gender == "nu" else ("Nam" if gender == "nam" else "")
            region_str = "Sài Gòn" if region == "nam" else ("Hà Nội" if region == "bac" else ("Miền Trung" if region == "trung" else ""))
            tags = [t for t in [gender_str, region_str, "VieNeu 48kHz"] if t]
            tag_str = f" [{ ' · '.join(tags) }]" if tags else ""
            
            out.append({
                "label": f"🌟 {short_name}{tag_str}",
                "id": vid,
                "name": short_name,
                "engine": "vieneu",
                "gender": gender,
                "region": region,
                "region_name": region_str,
                "accent_name": region_str,
                "style": m.get("style", "tu_nhien"),
            })

        # Append installed Piper ONNX voices with full rich metadata
        for p in _list_installed_piper_models():
            out.append(p)

        return out
    except Exception as e:
        raise HTTPException(500, f"Could not list voices: {e}\n\n{_init_error or ''}")


class PiperDownloadRequest(BaseModel):
    model_id: str


@app.get("/piper/catalog")
def piper_catalog():
    out = []
    for item in PIPER_CATALOG:
        mid = item["id"]
        onnx_file = PIPER_MODELS_DIR / f"{mid}.onnx"
        is_dl = onnx_file.exists()
        size_mb = round(onnx_file.stat().st_size / (1024 * 1024), 1) if is_dl else None
        out.append({
            **item,
            "is_downloaded": is_dl,
            "size_mb": size_mb,
        })
    return out


@app.post("/piper/download")
def piper_download(req: PiperDownloadRequest):
    import urllib.request
    cat_item = next((c for c in PIPER_CATALOG if c["id"] == req.model_id), None)
    if not cat_item:
        raise HTTPException(404, f"Không tìm thấy model {req.model_id} trong danh mục")

    try:
        base_url = cat_item.get("hf_base") or "https://huggingface.co/hoanglinhn0/Model/resolve/main/"
        for fname in cat_item["hf_files"]:
            target = PIPER_MODELS_DIR / fname
            if not target.exists():
                url = f"{base_url}{fname}"
                req_obj = urllib.request.Request(url, headers={"User-Agent": "VieNeu-Studio/1.0"})
                with urllib.request.urlopen(req_obj, timeout=120) as resp, open(target, "wb") as f:
                    shutil.copyfileobj(resp, f)
        _piper_voices.pop(req.model_id, None)
        return {"status": "ok", "message": f"Đã tải thành công giọng {cat_item['name']}"}
    except Exception as e:
        raise HTTPException(500, f"Lỗi tải model ONNX: {e}")


@app.post("/piper/import-files")
async def piper_import_files(files: List[UploadFile] = File(...)):
    imported = []
    for file in files:
        if file.filename and (file.filename.endswith(".onnx") or file.filename.endswith(".json")):
            dest = PIPER_MODELS_DIR / file.filename
            content = await file.read()
            dest.write_bytes(content)
            imported.append(file.filename)
            if file.filename.endswith(".onnx") and not file.filename.endswith(".onnx.json"):
                stem = file.filename.replace(".onnx", "")
                _piper_voices.pop(stem, None)
    return {"status": "ok", "imported": imported}


@app.post("/piper/open-folder")
def piper_open_folder():
    try:
        if platform.system() == "Windows":
            os.startfile(str(PIPER_MODELS_DIR))
        elif platform.system() == "Darwin":
            subprocess.run(["open", str(PIPER_MODELS_DIR)])
        else:
            subprocess.run(["xdg-open", str(PIPER_MODELS_DIR)])
        return {"status": "ok", "path": str(PIPER_MODELS_DIR)}
    except Exception as e:
        raise HTTPException(500, f"Không thể mở thư mục: {e}")


@app.delete("/piper/models/{model_id}")
def piper_delete_model(model_id: str):
    clean_id = model_id.replace("piper:", "").strip()
    cat_item = next((c for c in PIPER_CATALOG if c["id"] == clean_id), None)
    deleted = 0
    if cat_item:
        for fname in cat_item["hf_files"]:
            p = PIPER_MODELS_DIR / fname
            if p.exists():
                p.unlink()
                deleted += 1
    else:
        for f in PIPER_MODELS_DIR.glob(f"{clean_id}.*"):
            f.unlink()
            deleted += 1
    _piper_voices.pop(clean_id, None)
    return {"status": "ok", "deleted_files": deleted}


def _get_preview_text(voice_id: str) -> str:
    clean_id = voice_id.replace("piper:", "").strip()
    cat_item = next((c for c in PIPER_CATALOG if c["id"] == clean_id), None)
    if cat_item:
        lang = cat_item.get("lang")
        region = str(cat_item.get("region", ""))
        if lang == "fr":
            return "Bonjour! Ceci est un aperçu vocal en français sur VieNeu Studio."
        elif lang == "de":
            return "Hallo! Dies ist eine Sprachprobe auf Deutsch im VieNeu Studio."
        elif lang == "es":
            return "¡Hola! Esta es una muestra de voz en español en VieNeu Studio."
        elif lang == "it":
            return "Ciao! Questa è un'anteprima vocale in italiano su VieNeu Studio."
        elif lang == "zh":
            return "您好！这是 VieNeu Studio 的中文语音预览。"
        elif lang == "ja":
            return "こんにちは！これは VieNeu Studio の日本語音声サンプルです。"
        elif lang == "ko":
            return "안녕하세요! 이것은 VieNeu Studio의 한국어 음성 샘플입니다。"
        elif lang == "en" or region.startswith("us") or region.startswith("uk"):
            if "uk_scot" in region:
                return "Hello! This is a lovely Scottish voice preview for you."
            elif "uk" in region:
                return "Good day! This is a sample voice preview in British English."
            elif "newyork" in region:
                return "Hello, this is a sample voice preview from New York."
            elif "nammy" in region:
                return "Howdy! This is a voice preview with a Southern American accent."
            else:
                return "Hello! This is a clear English voice preview on VieNeu Studio."
    # Default Vietnamese
    return "Xin chào! Đây là giọng đọc mẫu tiếng Việt trên VieNeu Studio."


@app.get("/voices/{voice_id}/preview")
def voice_preview(voice_id: str):
    safe_name = "".join(c if c.isalnum() else "_" for c in voice_id) + ".wav"
    cache_path = PREVIEW_DIR / safe_name
    preview_txt = _get_preview_text(voice_id)
    if not cache_path.exists():
        try:
            if voice_id.startswith("piper:"):
                audio, sr = _infer_piper(voice_id, preview_txt)
                import soundfile as sf
                sf.write(str(cache_path), audio, samplerate=sr)
            else:
                tts = get_tts()
                _pin_seed(hash(voice_id) & 0x7FFFFFFF)
                audio = tts.infer(text=preview_txt, voice=voice_id)
                tts.save(audio, str(cache_path))
        except Exception as e:
            raise HTTPException(500, f"Could not generate preview: {e}")
    return FileResponse(str(cache_path), media_type="audio/wav")


class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    speed: Optional[float] = 1.0
    temperature: Optional[float] = 0.8
    seed: Optional[int] = None
    ref_audio_b64: Optional[str] = None
    ref_text: Optional[str] = None


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    if not req.text.strip():
        raise HTTPException(400, "Text is empty")
    used_seed = _pin_seed(req.seed)
    try:
        if req.voice and req.voice.startswith("piper:"):
            audio, sr = _infer_piper(req.voice, req.text)
            out_path = _save_audio(audio, speed=req.speed or 1.0, sample_rate=sr)
        else:
            tts = get_tts()
            infer_kwargs = {}
            if req.temperature is not None:
                infer_kwargs["temperature"] = req.temperature
            if req.ref_audio_b64:
                ref_path = _b64_to_temp_wav(req.ref_audio_b64)
                audio = tts.infer(text=req.text, ref_audio=ref_path, ref_text=req.ref_text, **infer_kwargs)
            else:
                audio = tts.infer(text=req.text, voice=req.voice, **infer_kwargs)
            out_path = _save_audio(audio, speed=req.speed or 1.0, sample_rate=48000)
    except Exception as e:
        raise HTTPException(500, f"Synthesis failed: {e}")
    return {"file_path": out_path, "filename": Path(out_path).name, "audio_url": f"/audio/{Path(out_path).name}", "seed": used_seed}


@app.post("/synthesize/stream")
def synthesize_stream(req: SynthesizeRequest):
    """Stream audio chunks live in 16-bit PCM (48kHz Mono) starting from the very first seconds."""
    if not req.text.strip():
        raise HTTPException(400, "Text is empty")
    tts = get_tts()
    _pin_seed(req.seed)

    file_id = f"{uuid.uuid4().hex}.wav"
    out_path = OUTPUT_DIR / file_id

    def audio_generator():
        import numpy as np
        collected_chunks = []

        infer_kwargs = {}
        if req.temperature is not None:
            infer_kwargs["temperature"] = req.temperature

        try:
            if req.ref_audio_b64:
                ref_path = _b64_to_temp_wav(req.ref_audio_b64)
                stream_gen = tts.infer_stream(text=req.text, ref_audio=ref_path, ref_text=req.ref_text, **infer_kwargs)
            else:
                stream_gen = tts.infer_stream(text=req.text, voice=req.voice, **infer_kwargs)

            for chunk in stream_gen:
                if chunk is not None and len(chunk) > 0:
                    collected_chunks.append(chunk.astype(np.float32))
                    int16_chunk = np.clip(chunk * 32767.0, -32768, 32767).astype(np.int16)
                    yield int16_chunk.tobytes()

            if collected_chunks:
                full_audio = np.concatenate(collected_chunks)
                # Save complete file with speed adjustment if needed
                get_tts().save(full_audio, str(out_path))
                if abs((req.speed or 1.0) - 1.0) >= 0.02:
                    _adjust_audio_speed(str(out_path), req.speed or 1.0)
        except Exception as e:
            print(f"[Streaming Generator Error]: {e}", flush=True)

    headers = {
        "X-Audio-Filename": file_id,
        "X-Sample-Rate": "48000",
        "X-Channels": "1",
        "Cache-Control": "no-cache",
    }
    return StreamingResponse(audio_generator(), media_type="application/octet-stream", headers=headers)


@app.post("/conversation")
def conversation(req: ConversationRequest):
    tts = get_tts()
    if not req.lines:
        raise HTTPException(400, "No lines provided")

    try:
        import numpy as np
        clips = []
        for line in req.lines:
            voice_id = req.speaker_voices.get(line.speaker)
            if not voice_id:
                raise HTTPException(400, f"No voice assigned for speaker '{line.speaker}'")
            _pin_seed(_speaker_seed(line.speaker))
            clip = tts.infer(text=line.text, voice=voice_id)
            clips.append(clip)
        audio = np.concatenate(clips) if clips else None
        out_path = _save_audio(audio)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Conversation synthesis failed: {e}")
    return {"file_path": out_path}


# --- Story Parsing & Generation ----------------------------------------------
_STORY_LINE_RE = re.compile(r"^\s*([^\n:]{1,30}):\s*(.+)$")


def _looks_like_character_name(name: str) -> bool:
    name = name.strip()
    if not name:
        return False
    words = name.split()
    if not (1 <= len(words) <= 4):
        return False
    return name[0:1].isupper()


def _parse_story(text: str) -> List[dict]:
    segments: List[dict] = []
    narrator_buf: List[str] = []

    def flush_narrator():
        joined = " ".join(s.strip() for s in narrator_buf if s.strip()).strip()
        narrator_buf.clear()
        if joined:
            segments.append({"speaker": None, "text": joined})

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = _STORY_LINE_RE.match(line)
        if m:
            name, dialogue = m.group(1).strip(), m.group(2).strip()
            if dialogue and _looks_like_character_name(name):
                flush_narrator()
                segments.append({"speaker": name, "text": dialogue})
                continue
        narrator_buf.append(line)
    flush_narrator()
    return segments


@app.post("/story/parse")
def story_parse(req: StoryParseRequest):
    if not req.text.strip():
        raise HTTPException(400, "Text is empty")
    segments = _parse_story(req.text)
    if not segments:
        raise HTTPException(400, "Could not find any narration or dialogue in this text")
    characters = sorted({seg["speaker"] for seg in segments if seg["speaker"]})
    return {"segments": segments, "characters": characters}


@app.post("/story/generate")
def story_generate(req: StoryGenerateRequest):
    if not req.text.strip():
        raise HTTPException(400, "Text is empty")
    if not req.narrator_voice:
        raise HTTPException(400, "No narrator voice selected")

    segments = _parse_story(req.text)
    if not segments:
        raise HTTPException(400, "Could not find any narration or dialogue in this text")

    tts = get_tts()
    sr = getattr(tts, "sample_rate", 48000)

    try:
        import numpy as np
        gap_samples = max(int(sr * (req.gap_ms / 1000.0)), 0)
        silence = np.zeros(gap_samples, dtype=np.float32) if gap_samples else None

        clips = []
        for seg in segments:
            speaker = seg["speaker"]
            if speaker:
                voice_id = req.character_voices.get(speaker) or req.narrator_voice
                seed = _speaker_seed(speaker)
            else:
                voice_id = req.narrator_voice
                seed = _speaker_seed("__narrator__")
            _pin_seed(seed)
            clip = tts.infer(text=seg["text"], voice=voice_id)
            clips.append(clip.astype(np.float32))
            if silence is not None:
                clips.append(silence)

        if silence is not None and clips:
            clips = clips[:-1]

        audio = np.concatenate(clips) if clips else None
        out_path = _save_audio(audio)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Story synthesis failed: {e}")
    return {"file_path": out_path, "segment_count": len(segments)}


# --- Dubbing & SRT Parsing ---------------------------------------------------
def _parse_srt_timestamp(ts: str) -> int:
    """Parse '00:01:23,456' or '00:01:23.456' into milliseconds."""
    ts = ts.strip().replace(',', '.')
    parts = ts.split(':')
    if len(parts) == 3:
        h = float(parts[0])
        m = float(parts[1])
        s = float(parts[2])
        return int((h * 3600 + m * 60 + s) * 1000)
    return 0


def _parse_srt_content(srt_text: str) -> List[dict]:
    """Parse full SRT text into cues: [{'start_ms': int, 'end_ms': int, 'text': str}]."""
    cues = []
    blocks = re.split(r'\n\s*\n', srt_text.strip())
    for block in blocks:
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        # Find timestamp line
        time_idx = -1
        for i, line in enumerate(lines):
            if '-->' in line:
                time_idx = i
                break
        if time_idx == -1:
            continue

        time_line = lines[time_idx]
        parts = time_line.split('-->')
        if len(parts) != 2:
            continue

        start_ms = _parse_srt_timestamp(parts[0])
        end_ms = _parse_srt_timestamp(parts[1])
        text_lines = lines[time_idx + 1:]
        text = " ".join(text_lines).strip()
        if text:
            cues.append({
                "start_ms": start_ms,
                "end_ms": end_ms,
                "text": text
            })
    cues.sort(key=lambda x: x["start_ms"])
    return cues


@app.post("/dub/parse-srt")
def dub_parse_srt(req: DubSrtParseRequest):
    if not req.srt_text.strip():
        raise HTTPException(400, "Nội dung SRT trống")
    cues = _parse_srt_content(req.srt_text)
    if not cues:
        raise HTTPException(400, "Không tìm thấy đoạn phụ đề SRT hợp lệ nào")
    return {
        "cue_count": len(cues),
        "cues": cues
    }


@app.post("/dub/transcribe")
def dub_transcribe(req: DubAudioGenerateRequest):
    """Transcribe audio with faster-whisper and return timestamped cues."""
    if not req.audio_b64:
        raise HTTPException(400, "Không có tệp âm thanh")
    try:
        # pyrefly: ignore [missing-import]
        from faster_whisper import WhisperModel
    except ImportError:
        raise HTTPException(500, "faster-whisper chưa được cài đặt trong môi trường backend")

    raw_audio = base64.b64decode(req.audio_b64)
    tmp_audio = OUTPUT_DIR / f"whisper_in_{uuid.uuid4().hex}.wav"
    tmp_audio.write_bytes(raw_audio)

    try:
        model = WhisperModel("base", device="cpu", compute_type="int8")
        segments, _ = model.transcribe(str(tmp_audio), language=req.language or "vi")
        cues = []
        for seg in segments:
            text = seg.text.strip()
            if text:
                cues.append({
                    "start_ms": int(seg.start * 1000),
                    "end_ms": int(seg.end * 1000),
                    "text": text
                })
        if not cues:
            raise HTTPException(400, "Không nhận diện được giọng nói trong tệp")
        return {"cue_count": len(cues), "cues": cues}
    except Exception as e:
        raise HTTPException(500, f"Phiên âm thất bại: {e}")
    finally:
        try:
            tmp_audio.unlink(missing_ok=True)
        except Exception:
            pass


# --- Background Job Execution Helpers ----------------------------------------
def _split_into_sentences(text: str) -> List[str]:
    """Split text into sentence-level chunks for progressive synthesis and ETA tracking."""
    # Split by newlines or sentence-ending punctuation followed by whitespace
    chunks = re.split(r'(?<=[.!?…;\n])\s+', text.strip())
    sentences = [c.strip() for c in chunks if c.strip()]
    if not sentences:
        return [text.strip()]
    return sentences


def _run_single_synthesize_job(job: JobState, payload: dict):
    try:
        import numpy as np
        req = SynthesizeRequest(**payload)
        tts = get_tts()

        used_seed = _pin_seed(req.seed)
        job.meta["seed"] = used_seed

        infer_kwargs = {}
        if req.temperature is not None:
            infer_kwargs["temperature"] = req.temperature

        # Check if cloning or voice preset
        if req.ref_audio_b64:
            job.total_steps = 1
            job.update_progress(0)
            ref_path = _b64_to_temp_wav(req.ref_audio_b64)
            audio = tts.infer(text=req.text, ref_audio=ref_path, ref_text=req.ref_text, **infer_kwargs)
            out_path = _save_audio(audio, speed=req.speed or 1.0)
            job.file_path = out_path
            job.update_progress(1, out_path)
            job.status = "completed"
            return

        # Progressive sentence generation
        sentences = _split_into_sentences(req.text)
        job.total_steps = len(sentences)
        job.update_progress(0)
        job.chunk_paths = []

        is_piper = bool(req.voice and req.voice.startswith("piper:"))
        sr = 22050 if is_piper else 48000

        clips = []
        for i, sent in enumerate(sentences):
            while not job.pause_event.is_set():
                if job.cancel_event.is_set():
                    job.status = "cancelled"
                    return
                time.sleep(0.2)

            if job.cancel_event.is_set():
                job.status = "cancelled"
                return

            if is_piper:
                clip, sr = _infer_piper(req.voice, sent)
            else:
                _pin_seed(used_seed + i)
                clip = tts.infer(text=sent, voice=req.voice, **infer_kwargs)

            clips.append(clip.astype(np.float32))

            chunk_path = _save_audio(clip, speed=req.speed or 1.0, sample_rate=sr)
            job.chunk_paths.append(chunk_path)

            partial_audio = np.concatenate(clips)
            partial_path = _save_audio(partial_audio, speed=req.speed or 1.0, sample_rate=sr)
            job.update_progress(i + 1, partial_path)

        final_audio = np.concatenate(clips) if clips else None
        out_path = _save_audio(final_audio, speed=req.speed or 1.0, sample_rate=sr)
        job.file_path = out_path
        job.status = "completed"
    except Exception as e:
        job.status = "failed"
        job.error = str(e)


def _run_conversation_job(job: JobState, payload: dict):
    try:
        import numpy as np
        lines = payload.get("lines", [])
        speaker_voices = payload.get("speaker_voices", {})
        gap_ms = payload.get("gap_ms", payload.get("pause_ms", 500))
        temperature = payload.get("temperature", 0.8)
        global_speed = payload.get("speed", 1.0)
        
        total = len(lines)
        if total == 0:
            raise ValueError("Không có lượt thoại nào trong kịch bản")

        job.total_steps = total
        tts = get_tts()
        target_sr = 48000
        gap_samples = max(int(target_sr * (gap_ms / 1000.0)), 0)
        silence = np.zeros(gap_samples, dtype=np.float32) if gap_samples else None

        def _resample_48k(audio_arr, orig_sr):
            if orig_sr == target_sr:
                return audio_arr.astype(np.float32)
            num_samples = int(len(audio_arr) * target_sr / orig_sr)
            return np.interp(np.linspace(0, len(audio_arr), num_samples, endpoint=False), np.arange(len(audio_arr)), audio_arr).astype(np.float32)

        clips = []

        for i, line in enumerate(lines):
            while not job.pause_event.is_set():
                if job.cancel_event.is_set():
                    job.status = "cancelled"
                    return
                time.sleep(0.2)

            if job.cancel_event.is_set():
                job.status = "cancelled"
                return

            speaker = line.get("speaker", f"Nhân vật {i+1}")
            text = line.get("text", "").strip()
            if not text:
                continue

            voice_id = line.get("voice") or speaker_voices.get(speaker) or "thaisong"
            line_speed = float(line.get("speed") or global_speed or 1.0)

            # Synthesize with Piper or VieNeu
            if voice_id and voice_id.startswith("piper:"):
                clip, orig_sr = _infer_piper(voice_id, text)
                clip_48k = _resample_48k(clip, orig_sr)
            else:
                _pin_seed(_speaker_seed(speaker) + i)
                clip = tts.infer(text=text, voice=voice_id, temperature=temperature)
                clip_48k = clip.astype(np.float32)

            # Adjust line speed if specified
            if abs(line_speed - 1.0) >= 0.03:
                tmp_clip_path = _save_audio(clip_48k, speed=line_speed, sample_rate=target_sr)
                import soundfile as sf
                clip_48k, _ = sf.read(tmp_clip_path, dtype="float32")

            clips.append(clip_48k)
            if silence is not None:
                clips.append(silence)

            # Progressive preview update
            curr_audio = np.concatenate(clips) if clips else None
            partial_path = _save_audio(curr_audio, speed=1.0, sample_rate=target_sr)
            job.update_progress(i + 1, partial_path)

        if silence is not None and clips:
            clips = clips[:-1]

        final_audio = np.concatenate(clips) if clips else None
        out_path = _save_audio(final_audio, speed=1.0, sample_rate=target_sr)
        job.file_path = out_path
        job.status = "completed"
    except Exception as e:
        job.status = "failed"
        job.error = str(e)


def _run_story_job(job: JobState, payload: dict):
    try:
        import numpy as np
        text = payload.get("text", "")
        narrator_voice = payload.get("narrator_voice")
        character_voices = payload.get("character_voices", {})
        gap_ms = payload.get("gap_ms", 350)

        segments = _parse_story(text)
        if not segments:
            raise ValueError("Không tìm thấy đoạn truyện hợp lệ")

        job.total_steps = len(segments)
        tts = get_tts()
        sr = getattr(tts, "sample_rate", 48000)
        gap_samples = max(int(sr * (gap_ms / 1000.0)), 0)
        silence = np.zeros(gap_samples, dtype=np.float32) if gap_samples else None

        clips = []
        for i, seg in enumerate(segments):
            while not job.pause_event.is_set():
                if job.cancel_event.is_set():
                    job.status = "cancelled"
                    return
                time.sleep(0.3)

            if job.cancel_event.is_set():
                job.status = "cancelled"
                return

            speaker = seg["speaker"]
            if speaker:
                voice_id = character_voices.get(speaker) or narrator_voice
                seed = _speaker_seed(speaker)
            else:
                voice_id = narrator_voice
                seed = _speaker_seed("__narrator__")

            _pin_seed(seed)
            clip = tts.infer(text=seg["text"], voice=voice_id)
            clips.append(clip.astype(np.float32))
            if silence is not None:
                clips.append(silence)

            # Export partial
            partial_audio = np.concatenate(clips)
            partial_path = _save_audio(partial_audio)
            job.update_progress(i + 1, partial_path)

        if silence is not None and clips:
            clips = clips[:-1]

        final_audio = np.concatenate(clips) if clips else None
        job.file_path = _save_audio(final_audio)
        job.status = "completed"
    except Exception as e:
        job.status = "failed"
        job.error = str(e)


def _run_dub_srt_job(job: JobState, payload: dict):
    try:
        import numpy as np
        srt_text = payload.get("srt_text", "")
        voice = payload.get("voice", "")
        cues = _parse_srt_content(srt_text)
        if not cues:
            raise ValueError("Không có đoạn phụ đề hợp lệ")

        job.total_steps = len(cues)
        is_piper = voice.startswith("piper:")

        if is_piper:
            sr = 22050
        else:
            tts = get_tts()
            sr = getattr(tts, "sample_rate", 48000)

        # Place clips onto timeline
        max_time_ms = cues[-1]["end_ms"] + 1000
        total_samples = int((max_time_ms / 1000.0) * sr)
        timeline = np.zeros(total_samples, dtype=np.float32)

        _pin_seed(hash(voice) & 0x7FFFFFFF)

        for i, cue in enumerate(cues):
            while not job.pause_event.is_set():
                if job.cancel_event.is_set():
                    job.status = "cancelled"
                    return
                time.sleep(0.3)

            if job.cancel_event.is_set():
                job.status = "cancelled"
                return

            if is_piper:
                clip, actual_sr = _infer_piper(voice, cue["text"])
                clip = clip.astype(np.float32)
                if actual_sr != sr:
                    num_out = int(len(clip) * sr / actual_sr)
                    clip = np.interp(np.linspace(0, len(clip), num_out, endpoint=False), np.arange(len(clip)), clip).astype(np.float32)
            else:
                clip = tts.infer(text=cue["text"], voice=voice).astype(np.float32)
            start_sample = int((cue["start_ms"] / 1000.0) * sr)
            end_sample = start_sample + len(clip)

            if end_sample > len(timeline):
                extra = np.zeros(end_sample - len(timeline), dtype=np.float32)
                timeline = np.concatenate([timeline, extra])

            timeline[start_sample:end_sample] += clip

            partial_path = _save_audio(timeline[:end_sample], sample_rate=sr)
            job.update_progress(i + 1, partial_path)

        job.file_path = _save_audio(timeline, sample_rate=sr)
        job.status = "completed"
    except Exception as e:
        job.status = "failed"
        job.error = str(e)


def _run_dub_audio_job(job: JobState, payload: dict):
    """Transcribe audio then synthesize dubbed version with cue timing."""
    try:
        import numpy as np
        audio_b64 = payload.get("audio_b64", "")
        voice = payload.get("voice", "")
        language = payload.get("language", "vi")

        # Transcribe
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise ValueError("faster-whisper chưa được cài đặt. Chạy: pip install faster-whisper")

        raw_audio = base64.b64decode(audio_b64)
        tmp_audio = OUTPUT_DIR / f"whisper_in_{uuid.uuid4().hex}.wav"
        tmp_audio.write_bytes(raw_audio)

        try:
            model = WhisperModel("base", device="cpu", compute_type="int8")
            segments, _ = model.transcribe(str(tmp_audio), language=language or "vi")
            cues = []
            for seg in segments:
                text = seg.text.strip()
                if text:
                    cues.append({"start_ms": int(seg.start * 1000), "end_ms": int(seg.end * 1000), "text": text})
        finally:
            try:
                tmp_audio.unlink(missing_ok=True)
            except Exception:
                pass

        if not cues:
            raise ValueError("Không nhận diện được giọng nói trong tệp")

        job.total_steps = len(cues)
        is_piper = voice.startswith("piper:")

        if is_piper:
            sr = 22050
            timeline_samples_per_ms = sr / 1000.0
        else:
            tts = get_tts()
            sr = getattr(tts, "sample_rate", 48000)
            timeline_samples_per_ms = sr / 1000.0

        max_time_ms = cues[-1]["end_ms"] + 1000
        total_samples = int(max_time_ms * timeline_samples_per_ms)
        timeline = np.zeros(total_samples, dtype=np.float32)

        _pin_seed(hash(voice) & 0x7FFFFFFF)

        for i, cue in enumerate(cues):
            while not job.pause_event.is_set():
                if job.cancel_event.is_set():
                    job.status = "cancelled"
                    return
                time.sleep(0.3)
            if job.cancel_event.is_set():
                job.status = "cancelled"
                return

            if is_piper:
                clip, actual_sr = _infer_piper(voice, cue["text"])
                if actual_sr != sr:
                    num_out = int(len(clip) * sr / actual_sr)
                    clip = np.interp(np.linspace(0, len(clip), num_out, endpoint=False), np.arange(len(clip)), clip).astype(np.float32)
            else:
                clip = tts.infer(text=cue["text"], voice=voice).astype(np.float32)

            start_sample = int(cue["start_ms"] * timeline_samples_per_ms)
            end_sample = start_sample + len(clip)
            if end_sample > len(timeline):
                extra = np.zeros(end_sample - len(timeline), dtype=np.float32)
                timeline = np.concatenate([timeline, extra])
            timeline[start_sample:end_sample] += clip

            partial_path = _save_audio(timeline[:end_sample], sample_rate=sr)
            job.update_progress(i + 1, partial_path)

        job.file_path = _save_audio(timeline, sample_rate=sr)
        job.status = "completed"
    except Exception as e:
        job.status = "failed"
        job.error = str(e)


@app.post("/jobs/synthesize")
def job_synthesize(req: SynthesizeRequest):
    job_id = uuid.uuid4().hex
    job = JobState(job_id=job_id, job_type="synthesize", total_steps=1)
    with _jobs_lock:
        _jobs[job_id] = job

    t = threading.Thread(target=_run_single_synthesize_job, args=(job, req.model_dump()))
    t.daemon = True
    t.start()
    return {"job_id": job_id}





@app.post("/jobs/conversation")
def job_conversation(payload: dict):
    job_id = uuid.uuid4().hex
    job = JobState(job_id=job_id, job_type="conversation", total_steps=len(payload.get("lines", [])) or 1)
    with _jobs_lock:
        _jobs[job_id] = job

    t = threading.Thread(target=_run_conversation_job, args=(job, payload))
    t.daemon = True
    t.start()
    return {"job_id": job_id}


class ScriptParseRequest(BaseModel):
    script_text: str


@app.post("/conversation/parse-script")
def conversation_parse_script(req: ScriptParseRequest):
    lines = req.script_text.strip().splitlines()
    turns = []
    speakers_set = set()
    current_speaker = "Người nói 1"

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        # Pattern e.g. "Trúc Ly: Lời thoại..." or "[Trúc Ly] Lời thoại..."
        match = re.match(r'^(?:\[([^\]]+)\]|([^:：\-–—]+)[:：\-–—])\s*(.*)$', line)
        if match:
            spk = (match.group(1) or match.group(2) or "").strip()
            txt = (match.group(3) or "").strip()
            if spk and txt:
                current_speaker = spk
                speakers_set.add(current_speaker)
                turns.append({"speaker": current_speaker, "text": txt, "speed": 1.0})
                continue
            elif spk and not txt:
                current_speaker = spk
                speakers_set.add(current_speaker)
                continue
        speakers_set.add(current_speaker)
        turns.append({"speaker": current_speaker, "text": line, "speed": 1.0})

    return {
        "speakers": sorted(list(speakers_set)),
        "turns": turns,
        "total_turns": len(turns),
    }


@app.post("/jobs/story")
def job_story(req: StoryGenerateRequest):
    job_id = uuid.uuid4().hex
    job = JobState(job_id=job_id, job_type="story", total_steps=1)
    with _jobs_lock:
        _jobs[job_id] = job

    t = threading.Thread(target=_run_story_job, args=(job, req.model_dump()))
    t.daemon = True
    t.start()
    return {"job_id": job_id}


class DubAudioJobRequest(BaseModel):
    audio_b64: str
    voice: str
    language: str = "vi"


@app.post("/jobs/dub-srt")
def job_dub_srt(req: DubSrtGenerateRequest):
    job_id = uuid.uuid4().hex
    job = JobState(job_id=job_id, job_type="dub-srt", total_steps=1)
    with _jobs_lock:
        _jobs[job_id] = job

    t = threading.Thread(target=_run_dub_srt_job, args=(job, req.model_dump()))
    t.daemon = True
    t.start()
    return {"job_id": job_id}


@app.post("/jobs/dub-audio")
def job_dub_audio(req: DubAudioJobRequest):
    """Background job: transcribe audio then dub each cue."""
    job_id = uuid.uuid4().hex
    job = JobState(job_id=job_id, job_type="dub-audio", total_steps=1)
    with _jobs_lock:
        _jobs[job_id] = job

    t = threading.Thread(target=_run_dub_audio_job, args=(job, req.model_dump()))
    t.daemon = True
    t.start()
    return {"job_id": job_id}


@app.get("/jobs/{job_id}")
def get_job_status(job_id: str):
    job = _get_job(job_id)
    return job.to_dict()


@app.post("/jobs/{job_id}/pause")
def pause_job(job_id: str):
    job = _get_job(job_id)
    if job.status == "running":
        job.pause_event.clear()
        job.status = "paused"
    return {"status": job.status}


@app.post("/jobs/{job_id}/resume")
def resume_job(job_id: str):
    job = _get_job(job_id)
    if job.status == "paused":
        job.pause_event.set()
        job.status = "running"
    return {"status": job.status}


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    job = _get_job(job_id)
    job.cancel_event.set()
    job.pause_event.set()
    job.status = "cancelled"
    return {"status": job.status}


@app.get("/jobs/{job_id}/download-partial")
def download_partial_job(job_id: str):
    job = _get_job(job_id)
    path = job.partial_file_path or job.file_path
    if not path or not Path(path).exists():
        raise HTTPException(404, "Chưa có đoạn âm thanh nào được tạo xong")
    return FileResponse(path, media_type="audio/wav", filename=f"partial_{job_id}.wav")


# --- FFmpeg Video Muxing & Auto-Subtitle Hardsub ------------------------------
def _escape_ffmpeg_path(path_str: str) -> str:
    """Escape backslashes and colons in subtitle path for FFmpeg filter."""
    # FFmpeg filter parser requires escaping '\' -> '\\' and ':' -> '\:'
    # On Windows: C:\path\sub.srt -> C\:/path/sub.srt or C\\:/path/sub.srt
    p = str(Path(path_str).resolve()).replace('\\', '/')
    p = p.replace(':', r'\:')
    return p


@app.post("/video/mux")
def video_mux(req: VideoMuxRequest):
    ffmpeg_exe = _get_ffmpeg_exe()
    if not ffmpeg_exe:
        raise HTTPException(500, "Không tìm thấy FFmpeg trên hệ thống. Hãy đảm bảo imageio-ffmpeg đã được cài đặt.")

    dub_audio_path = OUTPUT_DIR / req.audio_filename
    if not dub_audio_path.exists():
        raise HTTPException(404, f"Không tìm thấy tệp âm thanh lồng tiếng: {req.audio_filename}")

    # Write video to temporary file
    video_raw = base64.b64decode(req.video_b64)
    temp_vid_in = OUTPUT_DIR / f"vid_in_{uuid.uuid4().hex}.mp4"
    temp_vid_in.write_bytes(video_raw)

    out_vid_name = f"muxed_{uuid.uuid4().hex}.mp4"
    out_vid_path = OUTPUT_DIR / out_vid_name

    temp_srt_path = None
    try:
        # Build FFmpeg command
        cmd = [ffmpeg_exe, "-y", "-i", str(temp_vid_in), "-i", str(dub_audio_path)]

        # Video Filter for hardsub
        vf_filters = []
        if req.burn_subtitles and req.srt_text and req.srt_text.strip():
            temp_srt_path = OUTPUT_DIR / f"sub_{uuid.uuid4().hex}.srt"
            # Write with UTF-8 encoding
            temp_srt_path.write_text(req.srt_text.strip(), encoding="utf-8")
            escaped_srt = _escape_ffmpeg_path(str(temp_srt_path))
            sub_style = "FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=0,MarginV=25,Alignment=2"
            vf_filters.append(f"subtitles='{escaped_srt}':force_style='{sub_style}'")

        if vf_filters:
            cmd.extend(["-vf", ",".join(vf_filters), "-c:v", "libx264", "-preset", "fast", "-crf", "22"])
        else:
            cmd.extend(["-c:v", "copy"])

        # Audio handling: replace or mix
        if req.mode == "mix":
            # Filter complex for mixing audio
            filter_complex = f"[0:a]volume={req.original_volume}[a0];[1:a]volume={req.dub_volume}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]"
            cmd.extend(["-filter_complex", filter_complex, "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-shortest"])
        else:
            # Replace mode: use dub audio directly
            cmd.extend(["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "192k", "-shortest"])

        cmd.append(str(out_vid_path))

        print(f"[FFmpeg Mux] Running: {' '.join(cmd)}", flush=True)
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=600)

        if res.returncode != 0 or not out_vid_path.exists():
            print(f"[FFmpeg Error]: {res.stderr}", flush=True)
            raise HTTPException(500, f"FFmpeg xử lý thất bại: {res.stderr[-500:]}")

        return {
            "status": "success",
            "video_filename": out_vid_name,
            "video_url": f"/video/{out_vid_name}"
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(500, "Xử lý video quá thời gian cho phép (timeout 10 phút)")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Lỗi ghép video: {e}")
    finally:
        try:
            temp_vid_in.unlink(missing_ok=True)
            if temp_srt_path:
                temp_srt_path.unlink(missing_ok=True)
        except Exception:
            pass


@app.get("/video/{filename}")
def get_video(filename: str):
    path = OUTPUT_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Không tìm thấy tệp video")
    return FileResponse(str(path), media_type="video/mp4")


@app.get("/audio/{filename}")
def get_audio(filename: str):
    path = OUTPUT_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(str(path), media_type="audio/wav")


if __name__ == "__main__":
    # pyrefly: ignore [missing-import]
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8722)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
