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
import io
import json
import os
import platform
import re

# Force single-threaded math ops BEFORE importing onnxruntime/vieneu — CPU
# multi-threaded float reduction isn't perfectly order-stable run to run,
# which can cause tiny audio differences even with the same seed+voice.
# Trade-off: slightly slower inference, in exchange for repeatable takes.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import tempfile
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# --- VieNeu SDK -------------------------------------------------------------
# mode="v3turbo" -> 48kHz, built-in speaker tokens, emotion cues, cloning,
# batched multi-speaker Conversation mode. CPU runs on ONNX (torch-free);
# a CUDA machine auto-switches to the PyTorch engine.
from vieneu import Vieneu  # noqa: E402

OUTPUT_DIR = Path(tempfile.gettempdir()) / "vieneu_studio_outputs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

PREVIEW_DIR = OUTPUT_DIR / "previews"
PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

VOICES_META_PATH = Path(__file__).parent / "voices_meta.json"
PREVIEW_TEXT = "Xin chào, đây là giọng đọc mẫu."


def _load_voice_meta() -> dict:
    try:
        data = json.loads(VOICES_META_PATH.read_text(encoding="utf-8"))
        data.pop("_comment", None)
        return data
    except Exception:
        return {}

_tts: Optional[Vieneu] = None
_init_error: Optional[str] = None

# `threads` controls onnxruntime's own intra-op thread pool (SessionOptions.
# intra_op_num_threads, passed through the SDK's `threads` kwarg). This is
# NOT the same knob as OMP_NUM_THREADS/OPENBLAS_NUM_THREADS above — those only
# affect numpy/BLAS. onnxruntime manages its own CPU threadpool independently,
# and with more than 1 intra-op thread, matmul reduction order (and therefore
# the exact float value of the logits) is not guaranteed to be identical
# between runs. Since sampling reads those logits through np.random.choice
# (the SDK's actual RNG, seeded fine by _pin_seed), float noise from
# multi-threaded reduction can flip which token gets drawn — and because
# generation is autoregressive per chunk, one flipped token early on cascades
# through the rest of that chunk. That's the mechanism behind both
# between-generation drift and within-generation drift on the same seed.
#
# threads=1 is the only setting that's bit-exact regardless of core count.
# threads=0 asks the SDK to pick automatically (~half the logical cores,
# capped at 8) — fastest, but reintroduces the non-determinism above.
# Any other explicit value is a manual trade-off point in between: still not
# guaranteed bit-exact (>1 thread has the same reduction-order risk as 0),
# but may reduce how OFTEN it drifts in practice on some CPUs, and lets
# people balance speed against how often they see it. This is a global
# engine setting (fixed at construction), so changing it tears down and
# rebuilds the engine on next use rather than applying per-request.
_threads_setting = 1  # default: bit-exact reproducibility over raw speed


def _cpu_thread_ceiling() -> int:
    return os.cpu_count() or 8


def get_tts() -> Vieneu:
    global _tts, _init_error
    if _tts is None:
        try:
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
)


@app.get("/system/cpu-info")
def cpu_info():
    """Logical core count (what `threads` is bounded by) plus a physical-core
    best-effort guess, for the Settings screen. Physical-core detection has no
    universal stdlib API, so this tries psutil first and falls back to a
    platform-specific read; if both fail, physical == logical."""
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
                import subprocess
                out = subprocess.check_output(
                    ["wmic", "cpu", "get", "NumberOfCores"], text=True, timeout=3
                )
                nums = [int(x) for x in out.split() if x.strip().isdigit()]
                if nums:
                    physical = sum(nums)
            elif platform.system() == "Darwin":
                import subprocess
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


class ThreadSettingsRequest(BaseModel):
    threads: int  # 0 = auto (SDK default, ~half cores, faster/may drift), 1 = safest, N = manual


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
        _threads_setting = req.threads
        _tts = None  # force reload with the new thread count on next get_tts()
    return {"threads": _threads_setting, "reload_pending": _tts is None}


# --- Schemas -----------------------------------------------------------------
class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None          # preset voice id
    ref_audio_b64: Optional[str] = None  # for instant cloning
    ref_text: Optional[str] = None
    seed: Optional[int] = None           # pin this to keep the SAME voice take-to-take
    temperature: Optional[float] = None  # "độ ngẫu nhiên" — lower = more stable/consistent


class ConversationLine(BaseModel):
    speaker: str
    text: str


class ConversationRequest(BaseModel):
    lines: List[ConversationLine]
    speaker_voices: dict  # {"speaker_name": "voice_id"}


class StoryParseRequest(BaseModel):
    text: str


class StoryGenerateRequest(BaseModel):
    text: str
    narrator_voice: str
    character_voices: dict = {}   # {"character_name": "voice_id"}
    gap_ms: int = 350             # silence between segments


# --- Routes ------------------------------------------------------------------
@app.get("/health")
def health():
    """Liveness check only — does NOT mean the model is loaded yet."""
    return {"status": "ok"}


@app.get("/ready")
def ready():
    """Readiness check — actually loads the model (first call may take a while
    while weights download from Hugging Face). Returns model init errors instead
    of crashing silently."""
    try:
        get_tts()
        return {"ready": True}
    except Exception as e:
        raise HTTPException(500, f"Model failed to load: {e}\n\n{_init_error or ''}")


@app.get("/voices")
def list_voices():
    try:
        tts = get_tts()
        raw = tts.list_preset_voices()  # [(label, voice_id), ...]
        meta = _load_voice_meta()
        out = []
        for label, vid in raw:
            m = meta.get(vid) or meta.get(label) or {}
            out.append({
                "label": label,
                "id": vid,
                "gender": m.get("gender", "chua_ro"),
                "region": m.get("region", "chua_ro"),
                "style": m.get("style", "chua_ro"),
            })
        return out
    except Exception as e:
        raise HTTPException(500, f"Could not list voices: {e}\n\n{_init_error or ''}")


@app.get("/voices/{voice_id}/preview")
def voice_preview(voice_id: str):
    """Cached ~2s sample per voice so the library can play a preview without
    re-synthesizing on every click."""
    from fastapi.responses import FileResponse
    safe_name = "".join(c if c.isalnum() else "_" for c in voice_id) + ".wav"
    cache_path = PREVIEW_DIR / safe_name
    if not cache_path.exists():
        tts = get_tts()
        _pin_seed(hash(voice_id) & 0x7FFFFFFF)
        try:
            audio = tts.infer(text=PREVIEW_TEXT, voice=voice_id)
        except Exception as e:
            raise HTTPException(500, f"Could not generate preview: {e}")
        tts.save(audio, str(cache_path))
    return FileResponse(str(cache_path), media_type="audio/wav")


def _save_audio(audio) -> str:
    file_id = f"{uuid.uuid4().hex}.wav"
    out_path = OUTPUT_DIR / file_id
    get_tts().save(audio, str(out_path))
    return str(out_path)


def _b64_to_temp_wav(b64_data: str) -> str:
    raw = base64.b64decode(b64_data)
    tmp = OUTPUT_DIR / f"ref_{uuid.uuid4().hex}.wav"
    tmp.write_bytes(raw)
    return str(tmp)


def _pin_seed(seed: Optional[int]) -> int:
    """Fix every RNG we can reach so the SAME voice + seed reproduces the SAME
    take. Without this, each call samples fresh noise and the same voice id
    can drift to a different-sounding read every time — this is the cause of
    'giọng đổi liên tục' reports."""
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
        import torch
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except Exception:
        pass
    try:
        import onnxruntime as ort
        ort.set_seed(seed)
    except Exception:
        pass
    return seed


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    if not req.text.strip():
        raise HTTPException(400, "Text is empty")
    tts = get_tts()
    used_seed = _pin_seed(req.seed)
    try:
        infer_kwargs = {}
        if req.temperature is not None:
            infer_kwargs["temperature"] = req.temperature
        if req.ref_audio_b64:
            ref_path = _b64_to_temp_wav(req.ref_audio_b64)
            audio = tts.infer(text=req.text, ref_audio=ref_path, ref_text=req.ref_text, **infer_kwargs)
        else:
            audio = tts.infer(text=req.text, voice=req.voice, **infer_kwargs)
        out_path = _save_audio(audio)
    except TypeError:
        # SDK build doesn't accept `temperature` — retry without it rather than fail the request.
        try:
            if req.ref_audio_b64:
                audio = tts.infer(text=req.text, ref_audio=ref_path, ref_text=req.ref_text)
            else:
                audio = tts.infer(text=req.text, voice=req.voice)
            out_path = _save_audio(audio)
        except Exception as e:
            raise HTTPException(500, f"Synthesis failed: {e}")
    except Exception as e:
        raise HTTPException(500, f"Synthesis failed: {e}")
    return {"file_path": out_path, "seed": used_seed}


import hashlib


def _speaker_seed(name: str) -> int:
    """Deterministic seed derived from a character/speaker name, so the same
    named character keeps the same-sounding take across lines/segments even
    without the user manually entering a seed."""
    return int(hashlib.sha256(name.encode("utf-8")).hexdigest()[:8], 16)


@app.post("/conversation")
def conversation(req: ConversationRequest):
    """Multi-speaker Conversation / Podcast mode (v3 Turbo batches the whole script).
    Each speaker gets a seed derived from their name, pinned for every line they
    speak, so the same character doesn't drift to a different-sounding voice
    line to line."""
    tts = get_tts()
    if not req.lines:
        raise HTTPException(400, "No lines provided")

    try:
        script = []
        for line in req.lines:
            voice_id = req.speaker_voices.get(line.speaker)
            if not voice_id:
                raise HTTPException(400, f"No voice assigned for speaker '{line.speaker}'")
            script.append({"voice": voice_id, "text": line.text, "seed": _speaker_seed(line.speaker)})

        audio = None
        if hasattr(tts, "infer_conversation"):
            # If the SDK's batched conversation API supports per-turn seeds, use it;
            # otherwise fall back to per-line synthesis below so seeding still works.
            try:
                audio = tts.infer_conversation(script)
            except TypeError:
                audio = None

        if audio is None:
            import numpy as np
            clips = []
            for turn in script:
                _pin_seed(turn["seed"])
                clip = tts.infer(text=turn["text"], voice=turn["voice"])
                clips.append(clip)
            audio = np.concatenate(clips) if clips else None

        out_path = _save_audio(audio)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Conversation synthesis failed: {e}")
    return {"file_path": out_path}


# --- Truyện (multi-character story mode) -------------------------------------
# Lightweight script syntax: a line of the form "Tên nhân vật: lời thoại" is
# treated as dialogue for that character; everything else is narration.
# Consecutive narration lines are merged into one segment so the narrator
# doesn't pause awkwardly between every sentence.
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
    """Returns an ordered list of {"speaker": str | None, "text": str}.
    speaker is None for narration."""
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
    """Preview pass: split the pasted story into narration/dialogue segments
    and list the distinct character names found, so the UI can render a
    voice-assignment row per character before generating any audio."""
    if not req.text.strip():
        raise HTTPException(400, "Text is empty")
    segments = _parse_story(req.text)
    if not segments:
        raise HTTPException(400, "Could not find any narration or dialogue in this text")
    characters = sorted({seg["speaker"] for seg in segments if seg["speaker"]})
    return {"segments": segments, "characters": characters}


@app.post("/story/generate")
def story_generate(req: StoryGenerateRequest):
    """Generate the full story: each dialogue segment uses its assigned
    character voice (falling back to the narrator voice if unassigned), each
    narration segment uses the narrator voice. Every character/narrator gets a
    name-derived pinned seed so the same character stays consistent across the
    whole story, then segments are joined with a short silence gap."""
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

        # Drop the trailing gap after the last segment.
        if silence is not None and clips:
            clips = clips[:-1]

        audio = np.concatenate(clips) if clips else None
        out_path = _save_audio(audio)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Story synthesis failed: {e}")
    return {"file_path": out_path, "segment_count": len(segments)}


@app.get("/audio/{filename}")
def get_audio(filename: str):
    from fastapi.responses import FileResponse
    path = OUTPUT_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(str(path), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8722)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
