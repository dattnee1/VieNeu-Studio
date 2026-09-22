// =====================================================
// VieNeu Studio — app.js (Redesigned 3-column UI)
// =====================================================

let BACKEND_URL = 'http://127.0.0.1:8722';
let voices = [];
let historyItems = [];
let convoLineCount = 0;
let lastDubAudioFilename = null;
let cpuLogicalCores = 8;
let currentThreads = 1;
let currentDevice = 'cpu';
let settingsLoaded = false;
let currentNav = 'studio';
let favoriteVoiceIds = JSON.parse(localStorage.getItem('vieneu_fav_voices') || '[]');
let backendReady = false;  // Track backend readiness globally
let convoTurns = [
  { id: 'turn_1', speaker: 'Người nói 1', voice: '', text: 'Chào anh, hôm nay công việc thế nào?', speed: 1.0 },
  { id: 'turn_2', speaker: 'Người nói 2', voice: '', text: 'Chào em! Anh vừa hoàn thành xong dự án rồi, tuyệt vời lắm!', speed: 1.0 }
];
let parsedScriptData = null;

// ── Helper: update ALL status indicators at once ──────────────────────────────
function setAllStatusUI(state, message) {
  // state: 'loading' | 'ready' | 'error'
  const dot   = document.getElementById('status-dot');
  const text  = document.getElementById('status-text');
  const dot2  = document.getElementById('status-dot-settings');
  const text2 = document.getElementById('status-text-settings');

  if (dot)  { dot.classList.remove('ready', 'error');  if (state === 'ready') dot.classList.add('ready');  else if (state === 'error') dot.classList.add('error'); }
  if (dot2) { dot2.classList.remove('ready', 'error'); if (state === 'ready') dot2.classList.add('ready'); else if (state === 'error') dot2.classList.add('error'); }
  if (text  && message) text.textContent  = message;
  if (text2 && message) text2.textContent = message;
}

// Auto-start active polling on page load so voices NEVER fail to show up
async function initStartup() {
  try {
    if (window.vieneu && window.vieneu.getBackendUrl) {
      const url = await window.vieneu.getBackendUrl();
      if (url) BACKEND_URL = url;
    }
  } catch (e) { }

  setAllStatusUI('loading', 'Đang khởi động…');

  let attempts = 0;
  const poll = async () => {
    attempts++;
    const ok = await loadVoices();
    if (!ok && attempts < 60) {
      setTimeout(poll, 1000);
    } else if (ok) {
      backendReady = true;
      setAllStatusUI('ready', 'Engine sẵn sàng');
      checkFFmpegStatus();
    } else {
      // After 60 attempts (~60s) still not ready
      setAllStatusUI('error', 'Không kết nối được backend');
    }
  };
  poll();
}

function showBackendError(message) {
  const banner = document.getElementById('error-banner');
  if (banner) {
    banner.textContent = `Lỗi Backend: ${message}`;
    banner.style.display = 'block';
  }
  showToast(`Lỗi Backend: ${message}`, 'error');
}

// Run immediately
initStartup();

// Backend status events from electron
if (window.vieneu && window.vieneu.onBackendStatus) {
  window.vieneu.onBackendStatus(async (payload) => {
    BACKEND_URL = payload.url || BACKEND_URL;

    if (payload.ready) {
      backendReady = true;
      setAllStatusUI('ready', 'Engine sẵn sàng');
      await loadVoices();
      checkFFmpegStatus();
    } else if (payload.error) {
      backendReady = false;
      setAllStatusUI('error', 'Lỗi khởi động');
      showBackendError(payload.message);
    } else if (payload.loading) {
      backendReady = false;
      setAllStatusUI('loading', payload.message || 'Đang tải mô hình…');
    }
  });
}

async function checkFFmpegStatus() {
  try {
    const res = await fetch(`${BACKEND_URL}/system/ffmpeg-status`);
    const data = await res.json();
    if (!data.available) console.warn('FFmpeg chưa sẵn sàng.');
  } catch (e) {
    console.warn('Không thể kiểm tra FFmpeg:', e);
  }
}

// =====================================================
// NAVIGATION — Main nav (sidebar) + sub-tabs
// =====================================================

// Which ctrl panel to show per nav
const NAV_CTRL_MAP = {
  studio: 'ctrl-studio',
  clone: 'ctrl-clone',
  story: 'ctrl-story',
  dub: 'ctrl-dub',
  batch: 'ctrl-batch',
  history: null,
  library: null,
  settings: null,
};

function switchNav(navKey) {
  currentNav = navKey;

  // Update nav-item active
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === navKey);
  });

  // Update top subtab-btn active
  document.querySelectorAll('.subtab-btn[data-studio-nav]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.studioNav === navKey);
  });

  // Show/hide nav-content panels
  document.querySelectorAll('.nav-content').forEach((panel) => {
    panel.style.display = 'none';
  });
  const target = document.getElementById(`nav-${navKey}`);
  if (target) target.style.display = 'flex';

  // Handle middle control column:
  const ctrlPanel = document.getElementById('ctrl-panel');
  const ctrlId = NAV_CTRL_MAP[navKey];

  document.querySelectorAll('.ctrl-section').forEach((s) => {
    s.style.display = 'none';
  });

  if (ctrlId) {
    if (ctrlPanel) ctrlPanel.style.display = 'flex';
    const ctrl = document.getElementById(ctrlId);
    if (ctrl) ctrl.style.display = 'flex';
  } else {
    // Hide middle ctrl panel completely for full-width views (Settings, Library, History)
    if (ctrlPanel) ctrlPanel.style.display = 'none';
  }

  if (navKey === 'settings') {
    loadSettingsPanel();
  } else if (navKey === 'library') {
    renderLibrary();
    loadPiperCatalog();
  } else if (navKey === 'batch') {
    renderConvoTurns();
  }
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchNav(btn.dataset.nav));
});

// Sub-tabs (inside studio nav-content)
document.querySelectorAll('.subtab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.studioNav) {
      switchNav(btn.dataset.studioNav);
      return;
    }
    const bar = btn.closest('.subtabs-bar');
    if (bar) {
      bar.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }

    const subtabKey = btn.dataset.subtab;
    const navContent = btn.closest('.nav-content');
    if (navContent) {
      navContent.querySelectorAll('.subtab-content').forEach(c => {
        c.style.display = 'none';
      });
      const subtabPanel = document.getElementById(`subtab-${subtabKey}`);
      if (subtabPanel) subtabPanel.style.display = 'flex';
    }
  });
});

// =====================================================
// Voices & Searchable Voice Selectors
// =====================================================
async function loadVoices() {
  try {
    const res = await fetch(`${BACKEND_URL}/voices`);
    if (!res.ok) return false;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return false;
    voices = data;
  } catch (e) {
    console.error('Failed to load voices', e);
    return false;
  }

  const voiceOpts = voices.map(v => `<option value="${v.id}">${escapeHtml(v.label)}</option>`).join('');

  const selectors = ['studio-voice', 'story-narrator-voice', 'dub-voice'];
  selectors.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.innerHTML = voiceOpts;
      setupSearchableVoiceSelect(id);
    }
  });

  // Connect Studio top search input
  const studioVoiceSearch = document.getElementById('studio-voice-search');
  if (studioVoiceSearch) {
    studioVoiceSearch.style.display = 'none'; // Hide duplicate search box as custom combobox handles it now
  }

  // Update ctrl header voice count
  const countEl = document.getElementById('ctrl-voice-count');
  if (countEl) countEl.textContent = `Giọng nói (${voices.length})`;

  renderConvoSpeakerVoices();
  renderLibrary();
  return true;
}

let currentPreviewAudio = null;
let currentPreviewBtn = null;

function toggleFavoriteVoice(voiceId) {
  if (favoriteVoiceIds.includes(voiceId)) {
    favoriteVoiceIds = favoriteVoiceIds.filter(id => id !== voiceId);
  } else {
    favoriteVoiceIds.push(voiceId);
  }
  localStorage.setItem('vieneu_fav_voices', JSON.stringify(favoriteVoiceIds));
}

function playVoicePreviewDirect(voiceId, btnEl) {
  if (currentPreviewAudio) {
    currentPreviewAudio.pause();
    currentPreviewAudio = null;
    if (currentPreviewBtn) {
      currentPreviewBtn.classList.remove('playing');
      currentPreviewBtn.innerHTML = '▶';
    }
  }

  if (currentPreviewBtn === btnEl) {
    currentPreviewBtn = null;
    return;
  }

  const audio = new Audio(`${BACKEND_URL}/voices/${encodeURIComponent(voiceId)}/preview`);
  currentPreviewAudio = audio;
  currentPreviewBtn = btnEl;
  btnEl.classList.add('playing');
  btnEl.innerHTML = '■';

  audio.play().catch(e => {
    console.warn('Preview playback failed:', e);
    btnEl.classList.remove('playing');
    btnEl.innerHTML = '▶';
  });

  audio.onended = () => {
    btnEl.classList.remove('playing');
    btnEl.innerHTML = '▶';
    currentPreviewAudio = null;
    currentPreviewBtn = null;
  };
}

function setupSearchableVoiceSelect(selectId) {
  const selectEl = document.getElementById(selectId);
  if (!selectEl) return;

  const parent = selectEl.parentElement;
  if (parent) {
    parent.querySelectorAll('.custom-combobox').forEach(el => el.remove());
  }
  selectEl.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-combobox';


  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'combobox-input';
  input.placeholder = '🔍 Gõ tìm nhanh giọng đọc...';

  const selectedOpt = selectEl.options[selectEl.selectedIndex];
  if (selectedOpt) input.value = selectedOpt.text;

  const dropdown = document.createElement('div');
  dropdown.className = 'combobox-dropdown';
  dropdown.style.display = 'none';

  function renderOptions(query = '') {
    const q = query.toLowerCase().trim();
    dropdown.innerHTML = '';
    let hasMatch = false;
    Array.from(selectEl.options).forEach(opt => {
      const voiceInfo = voices.find(v => v.id === opt.value);
      let searchString = opt.text.toLowerCase();
      if (voiceInfo) {
        searchString = `${voiceInfo.label} ${voiceInfo.name || ''} ${voiceInfo.region_name || ''} ${voiceInfo.gender || ''} ${voiceInfo.id}`.toLowerCase();
      }

      if (!q || searchString.includes(q)) {
        hasMatch = true;
        const div = document.createElement('div');
        div.className = 'combobox-option' + (opt.value === selectEl.value ? ' selected' : '');
        div.textContent = opt.text;

        // Use mousedown instead of click — fires before blur hides dropdown
        div.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectEl.value = opt.value;
          input.value = opt.text;
          dropdown.style.display = 'none';
          selectEl.dispatchEvent(new Event('change'));
        });
        dropdown.appendChild(div);
      }
    });
    if (!hasMatch) {
      const empty = document.createElement('div');
      empty.className = 'combobox-option';
      empty.style.color = 'var(--text-muted)';
      empty.style.fontStyle = 'italic';
      empty.style.pointerEvents = 'none';
      empty.textContent = 'Không tìm thấy kết quả';
      dropdown.appendChild(empty);
    }
  }

  input.addEventListener('focus', () => {
    input.value = '';
    renderOptions();
    dropdown.style.display = 'block';
  });

  input.addEventListener('input', (e) => {
    renderOptions(e.target.value);
    dropdown.style.display = 'block';
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      dropdown.style.display = 'none';
      const currentOpt = selectEl.options[selectEl.selectedIndex];
      if (currentOpt) input.value = currentOpt.text;
    }, 150);
  });

  wrapper.appendChild(input);
  wrapper.appendChild(dropdown);
  selectEl.parentElement.insertBefore(wrapper, selectEl);
}

// Refresh voices button
document.getElementById('ctrl-refresh-voices').addEventListener('click', async () => {
  await loadVoices();
  showToast('Đã tải lại danh sách giọng!', 'ready');
});

// Refresh convo voices button
const ctrlRefreshConvoVoices = document.getElementById('ctrl-refresh-convo-voices');
if (ctrlRefreshConvoVoices) {
  ctrlRefreshConvoVoices.addEventListener('click', async () => {
    await loadVoices();
    renderConvoTurns();
    showToast('Đã tải lại danh sách giọng!', 'ready');
  });
}

// =====================================================
// Voice description
// =====================================================
const VOICE_DESC_MAP = {
  'Tự nhiên': 'Giọng đọc tự nhiên vốn có, phù hợp cho nhiều ngữ cảnh.',
};
document.getElementById('studio-voice').addEventListener('change', () => {
  // Could show a description — for now just reset
});

// =====================================================
// Cue chips (emotion tags) → insert into active textarea
// =====================================================
document.querySelectorAll('.cue-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    // Find the currently visible main-textarea
    const ta = document.getElementById('studio-text');
    if (!ta) return;
    const cue = chip.dataset.cue;
    const pos = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, pos) + ' ' + cue + ' ' + ta.value.slice(pos);
    ta.focus();
    updateCharCount('studio-text', 'studio-char-count');
  });
});

// =====================================================
// Randomness & Speed sliders
// =====================================================
const randomnessSlider = document.getElementById('randomness-slider');
const randomnessVal = document.getElementById('randomness-val');
if (randomnessSlider) {
  randomnessSlider.addEventListener('input', () => {
    randomnessVal.textContent = parseFloat(randomnessSlider.value).toFixed(2);
    updateSliderGradient(randomnessSlider);
  });
  updateSliderGradient(randomnessSlider);
}

const speedSlider = document.getElementById('speed-slider');
const speedVal = document.getElementById('speed-val');
if (speedSlider) {
  speedSlider.addEventListener('input', () => {
    if (speedVal) speedVal.textContent = `${parseFloat(speedSlider.value).toFixed(2)}x`;
    updateSliderGradient(speedSlider);
  });
  updateSliderGradient(speedSlider);
}

function updateSliderGradient(slider) {
  if (!slider) return;
  const val = ((parseFloat(slider.value) - parseFloat(slider.min)) / (parseFloat(slider.max) - parseFloat(slider.min))) * 100;
  slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${val}%, var(--bg-card-2) ${val}%)`;
}

// =====================================================
// Char count helper
// =====================================================
function updateCharCount(textareaId, counterId) {
  const ta = document.getElementById(textareaId);
  const counter = document.getElementById(counterId);
  if (!ta || !counter) return;
  counter.textContent = `${ta.value.length} ký tự`;
}

// =====================================================
// Import .txt file
// =====================================================
const studioImportBtn = document.getElementById('studio-import-btn');
const studioImportFile = document.getElementById('studio-import-file');
if (studioImportBtn && studioImportFile) {
  studioImportBtn.addEventListener('click', () => studioImportFile.click());
  studioImportFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    document.getElementById('studio-text').value = text;
    updateCharCount('studio-text', 'studio-char-count');
    updateStudioGenerateAvailability();
    e.target.value = '';
  });
}

// =====================================================
// Studio (TTS) tab
// =====================================================
let lastStudioSeed = null;

function updateStudioGenerateAvailability() {
  const text = document.getElementById('studio-text').value.trim();
  const btn = document.getElementById('studio-generate');
  if (btn) btn.disabled = !text;
}

document.getElementById('studio-text').addEventListener('input', () => {
  updateStudioGenerateAvailability();
  updateCharCount('studio-text', 'studio-char-count');
});
updateStudioGenerateAvailability();

document.getElementById('studio-seed-random').addEventListener('click', () => {
  document.getElementById('studio-seed').value = Math.floor(Math.random() * 1e9);
});

// =====================================================
// Studio Generation & Media Controller
// =====================================================
let currentStudioJobId = null;
let currentStudioStatus = 'idle'; // 'idle' | 'running' | 'paused'
let studioPollTimer = null;

const studioGenerateBtn = document.getElementById('studio-generate');
const studioCancelBtn = document.getElementById('studio-cancel');
const studioProgressBlock = document.getElementById('studio-progress');
const studioAudioPlayer = document.getElementById('studio-audio');
const studioDownloadLink = document.getElementById('studio-download');

// Cancel button
if (studioCancelBtn) {
  studioCancelBtn.addEventListener('click', async () => {
    if (!currentStudioJobId) return;
    if (!confirm('Bạn có chắc muốn hủy tiến trình tạo giọng này?')) return;
    try {
      await fetch(`${BACKEND_URL}/jobs/${currentStudioJobId}/cancel`, { method: 'POST' });
    } catch (e) { }
    cleanupStudioJob('cancelled');
  });
}

// Main Generate / Pause / Resume button
if (studioGenerateBtn) {
  studioGenerateBtn.addEventListener('click', async () => {
    if (currentStudioStatus === 'idle') {
      startStudioGeneration();
    } else if (currentStudioStatus === 'running') {
      pauseStudioGeneration();
    } else if (currentStudioStatus === 'paused') {
      resumeStudioGeneration();
    }
  });
}

async function startStudioGeneration() {
  const text = document.getElementById('studio-text').value.trim();
  const voice = document.getElementById('studio-voice').value;
  const seedInput = document.getElementById('studio-seed').value.trim();
  const seed = seedInput ? parseInt(seedInput, 10) : 1;
  const temperature = randomnessSlider ? parseFloat(randomnessSlider.value) : 0.8;
  const speed = speedSlider ? parseFloat(speedSlider.value) : 1.0;

  if (!text) {
    showToast('Hãy nhập nội dung văn bản trước.');
    return;
  }

  currentStudioStatus = 'running';

  studioGenerateBtn.textContent = '⏸ Tạm dừng';
  studioGenerateBtn.classList.add('working');
  studioGenerateBtn.classList.remove('paused');
  if (studioCancelBtn) studioCancelBtn.style.display = 'inline-flex';

  const resultSection = document.getElementById('studio-result');
  if (resultSection) resultSection.style.display = 'block';

  if (studioProgressBlock) {
    studioProgressBlock.classList.remove('hidden');
    studioProgressBlock.innerHTML = `
      <div class="progress-info">
        <span>Đang khởi động tạo giọng…</span>
        <span>Chạy: 00:00 | Còn: --:--</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-fill" style="width: 5%;"></div>
      </div>
    `;
  }

  if (studioDownloadLink) {
    studioDownloadLink.style.display = 'inline-flex';
    studioDownloadLink.textContent = '⬇ Tải phần đã tạo';
  }

  try {
    const startRes = await fetch(`${BACKEND_URL}/jobs/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, seed, temperature, speed }),
    });
    const startData = await startRes.json();
    if (!startRes.ok) throw new Error(startData.detail || 'Lỗi khởi tạo tác vụ');

    currentStudioJobId = startData.job_id;
    if (studioDownloadLink) {
      studioDownloadLink.href = `${BACKEND_URL}/jobs/${currentStudioJobId}/download-partial`;
    }

    if (studioPollTimer) clearInterval(studioPollTimer);
    studioPollTimer = setInterval(pollStudioJob, 350);

  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
    cleanupStudioJob('failed');
  }
}

async function pollStudioJob() {
  if (!currentStudioJobId) return;
  try {
    const res = await fetch(`${BACKEND_URL}/jobs/${currentStudioJobId}`);
    if (!res.ok) return;
    const jobData = await res.json();

    const progress = jobData.progress || 0;
    const currentStep = jobData.current_step || 0;
    const totalSteps = jobData.total_steps || 1;
    const elapsed = formatSeconds(jobData.elapsed_time);
    const eta = formatSeconds(jobData.eta_seconds);
    const isPaused = jobData.status === 'paused';

    if (studioProgressBlock) {
      studioProgressBlock.innerHTML = `
        <div class="progress-info">
          <span>${isPaused ? '⏸ Đang tạm dừng' : '⚡ Đang tạo giọng đọc…'} (${currentStep}/${totalSteps} câu - ${progress.toFixed(0)}%)</span>
          <span>Chạy: ${elapsed} | Còn: ${eta}</span>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-fill" style="width: ${progress}%;"></div>
        </div>
      `;
    }

    // Dynamic download link: allow download anytime!
    if (studioDownloadLink) {
      if (jobData.status === 'completed' && jobData.file_path) {
        const fn = getFilenameFromPath(jobData.file_path);
        studioDownloadLink.href = `${BACKEND_URL}/audio/${encodeURIComponent(fn)}`;
        studioDownloadLink.textContent = '⬇ Tải file .wav hoàn chỉnh';
        studioDownloadLink.download = `studio_audio_${Date.now()}.wav`;
      } else {
        studioDownloadLink.href = `${BACKEND_URL}/jobs/${currentStudioJobId}/download-partial`;
        studioDownloadLink.textContent = currentStep > 0
          ? `⬇ Tải phần đã tạo (${currentStep}/${totalSteps})`
          : '⬇ Tải phần đã tạo';
        studioDownloadLink.download = `studio_partial_${Date.now()}.wav`;
      }
    }

    // Keep media player synced with partial/full audio (playback is fully controlled by the user via media bar)
    if (jobData.partial_audio_url && studioAudioPlayer) {
      const partialUrl = `${BACKEND_URL}${jobData.partial_audio_url}`;
      if (!studioAudioPlayer.src.includes(jobData.partial_filename)) {
        const wasPlaying = !studioAudioPlayer.paused;
        const currentPos = studioAudioPlayer.currentTime;
        studioAudioPlayer.src = partialUrl;
        studioAudioPlayer.currentTime = currentPos;
        if (wasPlaying) {
          studioAudioPlayer.play().catch(() => { });
        }
      }
    }

    // Handle status transitions
    if (jobData.status === 'completed') {
      cleanupStudioJob('completed', jobData);
    } else if (jobData.status === 'paused') {
      currentStudioStatus = 'paused';
      studioGenerateBtn.textContent = '▶ Tiếp tục';
      studioGenerateBtn.classList.remove('working');
      studioGenerateBtn.classList.add('paused');
    } else if (jobData.status === 'running') {
      currentStudioStatus = 'running';
      studioGenerateBtn.textContent = '⏸ Tạm dừng';
      studioGenerateBtn.classList.add('working');
      studioGenerateBtn.classList.remove('paused');
    } else if (jobData.status === 'cancelled') {
      cleanupStudioJob('cancelled');
    } else if (jobData.status === 'failed') {
      cleanupStudioJob('failed', jobData);
    }

  } catch (err) {
    console.error('Error polling studio job:', err);
  }
}

async function pauseStudioGeneration() {
  if (!currentStudioJobId) return;
  try {
    await fetch(`${BACKEND_URL}/jobs/${currentStudioJobId}/pause`, { method: 'POST' });
    currentStudioStatus = 'paused';
    studioGenerateBtn.textContent = '▶ Tiếp tục';
    studioGenerateBtn.classList.remove('working');
    studioGenerateBtn.classList.add('paused');
    // Pause studio audio playback if playing
    if (studioAudioPlayer && !studioAudioPlayer.paused) {
      studioAudioPlayer.pause();
    }
    showToast('Đã tạm dừng tạo giọng.', 'pending');
  } catch (e) {
    showToast(`Lỗi tạm dừng: ${e.message}`, 'error');
  }
}

async function resumeStudioGeneration() {
  if (!currentStudioJobId) return;
  try {
    await fetch(`${BACKEND_URL}/jobs/${currentStudioJobId}/resume`, { method: 'POST' });
    currentStudioStatus = 'running';
    studioGenerateBtn.textContent = '⏸ Tạm dừng';
    studioGenerateBtn.classList.add('working');
    studioGenerateBtn.classList.remove('paused');
    showToast('Đang tiếp tục tạo giọng…', 'ready');
  } catch (e) {
    showToast(`Lỗi tiếp tục: ${e.message}`, 'error');
  }
}

function cleanupStudioJob(status, data = {}) {
  if (studioPollTimer) {
    clearInterval(studioPollTimer);
    studioPollTimer = null;
  }
  currentStudioStatus = 'idle';
  studioGenerateBtn.textContent = '▶ Tạo giọng đọc';
  studioGenerateBtn.classList.remove('working', 'paused');
  if (studioCancelBtn) studioCancelBtn.style.display = 'none';

  if (status === 'completed') {
    const text = document.getElementById('studio-text').value.trim();
    const voice = document.getElementById('studio-voice').value;
    const speed = speedSlider ? parseFloat(speedSlider.value) : 1.0;
    const seed = data.meta?.seed || 1;

    let audioUrl = null;
    if (data.file_path && studioAudioPlayer) {
      const filename = getFilenameFromPath(data.file_path);
      audioUrl = `${BACKEND_URL}/audio/${encodeURIComponent(filename)}`;
      studioAudioPlayer.src = audioUrl;
      if (studioDownloadLink) {
        studioDownloadLink.href = audioUrl;
        studioDownloadLink.textContent = '⬇ Tải file .wav';
        studioDownloadLink.download = `studio_audio_${Date.now()}.wav`;
      }
    }

    addHistoryItem(text, `${voice} · ${speed}x · seed ${seed}`, audioUrl);
    showRecentSection();
    showToast('Đã tạo xong toàn bộ giọng đọc!', 'ready');
  } else if (status === 'cancelled') {
    if (studioProgressBlock) studioProgressBlock.classList.add('hidden');
    showToast('Đã hủy tiến trình tạo giọng.', 'pending');
  } else if (status === 'failed') {
    if (studioProgressBlock) studioProgressBlock.classList.add('hidden');
    showToast(`Lỗi tạo giọng: ${data.error || 'Thất bại'}`, 'error');
  }
}

function showRecentSection() {
  const rs = document.getElementById('studio-recent-section');
  if (rs) rs.style.display = 'flex';
}

// =====================================================
// Clone tab (inside ctrl panel)
// =====================================================
let cloneFileB64 = null;

const cloneFileBtn = document.getElementById('clone-file-btn');
const cloneFileInput = document.getElementById('clone-file');
const cloneFileNameEl = document.getElementById('clone-file-name');

if (cloneFileBtn) {
  cloneFileBtn.addEventListener('click', () => cloneFileInput.click());
}
if (cloneFileInput) {
  cloneFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (cloneFileNameEl) cloneFileNameEl.textContent = file ? file.name : 'Chưa chọn file';
    if (!file) { cloneFileB64 = null; return; }
    const buf = await file.arrayBuffer();
    cloneFileB64 = arrayBufferToBase64(buf);
  });
}

const cloneGenerateBtn = document.getElementById('clone-generate');
if (cloneGenerateBtn) {
  cloneGenerateBtn.addEventListener('click', async () => {
    // Use the subtab textarea if visible, else ctrl panel ref text
    let text = '';
    const mainTa = document.getElementById('clone-text');
    const fullTa = document.getElementById('clone-text-full');
    if (mainTa && mainTa.value.trim()) text = mainTa.value.trim();
    else if (fullTa && fullTa.value.trim()) text = fullTa.value.trim();

    const refText = document.getElementById('clone-ref-text')?.value.trim() ||
      document.getElementById('clone-ref-text-full')?.value.trim() || '';

    if (!text) { showToast('Hãy nhập văn bản muốn đọc.'); return; }
    if (!cloneFileB64) { showToast('Vui lòng chọn file âm thanh mẫu trước.'); return; }

    startBackgroundJob({
      endpoint: '/jobs/synthesize',
      payload: { text, ref_audio_b64: cloneFileB64, ref_text: refText || null },
      progressBlockId: 'clone-progress',
      generateBtn: cloneGenerateBtn,
      generateBtnText: '▶ Nhân bản & đọc',
      resultPrefix: 'clone',
      historyTitle: text,
      historySub: 'Giọng nhân bản'
    });
  });
}

// =====================================================
// Conversation (Hội thoại / Batch) tab
// =====================================================
function addConvoLine(speaker = '', text = '') {
  convoLineCount += 1;
  const wrap = document.createElement('div');
  wrap.className = 'convo-line';
  wrap.innerHTML = `
    <input type="text" class="line-speaker" placeholder="Nhân vật" value="${escapeHtml(speaker)}" />
    <textarea class="line-text" placeholder="Lời thoại…">${escapeHtml(text)}</textarea>
    <button class="remove-line" title="Xoá dòng">✕</button>
  `;
  wrap.querySelector('.remove-line').addEventListener('click', () => {
    wrap.remove();
    renderConvoSpeakerVoices();
  });
  wrap.querySelector('.line-speaker').addEventListener('change', renderConvoSpeakerVoices);
  const linesContainer = document.getElementById('convo-lines');
  if (linesContainer) linesContainer.appendChild(wrap);
  renderConvoSpeakerVoices();
}

const convoAddBtn = document.getElementById('convo-add-line');
if (convoAddBtn) convoAddBtn.addEventListener('click', () => addConvoLine());

function getConvoSpeakers() {
  const names = new Set();
  document.querySelectorAll('.line-speaker').forEach((el) => {
    const v = el.value.trim();
    if (v) names.add(v);
  });
  return Array.from(names);
}

function renderConvoSpeakerVoices() {
  const container = document.getElementById('convo-speaker-voices');
  if (!container) return;
  const speakers = getConvoSpeakers();
  if (speakers.length === 0) {
    container.innerHTML = '<p class="empty-note">Thêm lời thoại và đặt tên nhân vật để gán giọng.</p>';
    return;
  }
  const options = voices.map(v => `<option value="${v.id}">${v.label}</option>`).join('');
  container.innerHTML = speakers.map((s) => `
    <div class="speaker-voice-row">
      <label>${escapeHtml(s)}</label>
      <select class="select speaker-voice-select" data-speaker="${escapeHtml(s)}">${options}</select>
    </div>
  `).join('');
}

const convoGenerateBtn = document.getElementById('convo-generate');
if (convoGenerateBtn) {
  convoGenerateBtn.addEventListener('click', async () => {
    const lines = Array.from(document.querySelectorAll('.convo-line')).map((el) => ({
      speaker: el.querySelector('.line-speaker').value.trim(),
      text: el.querySelector('.line-text').value.trim(),
    })).filter(l => l.speaker && l.text);

    if (lines.length === 0) { showToast('Hãy thêm ít nhất một lời thoại có tên nhân vật.'); return; }

    const speakerVoices = {};
    document.querySelectorAll('.speaker-voice-select').forEach((sel) => {
      speakerVoices[sel.dataset.speaker] = sel.value;
    });

    startBackgroundJob({
      endpoint: '/jobs/conversation',
      payload: { lines, speaker_voices: speakerVoices },
      progressBlockId: 'convo-progress',
      generateBtn: convoGenerateBtn,
      generateBtnText: '▶ Tạo hội thoại',
      resultPrefix: 'convo',
      historyTitle: `Hội thoại (${lines.length} lời thoại)`,
      historySub: Object.values(speakerVoices).join(', ')
    });
  });
}

// Initialize convo lines
addConvoLine('Nhân vật A', '');
addConvoLine('Nhân vật B', '');

// =====================================================
// Story (Truyện) tab
// =====================================================
let storyCharacters = [];

function setStoryParseStatus(message, kind) {
  const el = document.getElementById('story-parse-status');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'settings-status' + (kind ? ` ${kind}` : '');
}

function renderStoryCharacterVoices(preassignedVoices = {}) {
  const container = document.getElementById('story-character-voices');
  const labelEl = document.getElementById('story-characters-label');
  if (!container) return;
  if (storyCharacters.length === 0) {
    container.innerHTML = '';
    if (labelEl) labelEl.style.display = 'none';
    return;
  }
  if (labelEl) labelEl.style.display = '';
  container.innerHTML = storyCharacters.map((name) => {
    const selectedVoice = preassignedVoices[name] || '';
    return `
      <div class="speaker-voice-row">
        <label>${escapeHtml(name)}</label>
        <select class="select story-character-voice-select" data-character="${escapeHtml(name)}">
          ${voices.map(v => `<option value="${v.id}" ${v.id === selectedVoice ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </div>
    `;
  }).join('');
}

const storyParseBtn = document.getElementById('story-parse');
if (storyParseBtn) {
  storyParseBtn.addEventListener('click', async () => {
    const text = document.getElementById('story-text').value.trim();
    if (!text) { showToast('Hãy dán nội dung truyện trước.'); return; }

    setStoryParseStatus('Đang phân tích…', 'pending');
    document.getElementById('story-generate').disabled = true;
    try {
      const res = await fetch(`${BACKEND_URL}/story/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Lỗi không xác định');
      storyCharacters = data.characters || [];
      renderStoryCharacterVoices();
      setStoryParseStatus(`Tìm thấy ${data.segments.length} đoạn (${storyCharacters.length} nhân vật). Gán giọng rồi tạo audiobook.`);
      document.getElementById('story-generate').disabled = false;
    } catch (e) {
      setStoryParseStatus(`Lỗi: ${e.message}`, 'error');
      storyCharacters = [];
      renderStoryCharacterVoices();
    }
  });
}

// Story: Save project
const storySaveBtn = document.getElementById('story-save-project');
if (storySaveBtn) {
  storySaveBtn.addEventListener('click', () => {
    const text = document.getElementById('story-text').value.trim();
    if (!text) { showToast('Kịch bản truyện đang trống.'); return; }
    const narratorVoice = document.getElementById('story-narrator-voice').value;
    const characterVoices = {};
    document.querySelectorAll('.story-character-voice-select').forEach((sel) => {
      characterVoices[sel.dataset.character] = sel.value;
    });
    const projectData = {
      type: 'vieneu-story-project', version: 1,
      exported_at: new Date().toISOString(),
      text, narrator_voice: narratorVoice,
      characters: storyCharacters,
      character_voices: characterVoices
    };
    downloadJSON(projectData, `du_an_truyen_${Date.now()}.json`);
    showToast('Đã xuất file dự án truyện (.json)!', 'ready');
  });
}

// Story: Load project
const storyLoadBtn = document.getElementById('story-load-project');
const storyProjectFileInput = document.getElementById('story-project-file-input');
if (storyLoadBtn) storyLoadBtn.addEventListener('click', () => storyProjectFileInput.click());
if (storyProjectFileInput) {
  storyProjectFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const project = JSON.parse(raw);
      if (project.type !== 'vieneu-story-project' && !project.text) throw new Error('Định dạng tệp không hợp lệ.');
      document.getElementById('story-text').value = project.text || '';
      if (project.narrator_voice) document.getElementById('story-narrator-voice').value = project.narrator_voice;
      storyCharacters = project.characters || [];
      renderStoryCharacterVoices(project.character_voices || {});
      document.getElementById('story-generate').disabled = !project.text;
      setStoryParseStatus(`Đã nạp dự án: ${storyCharacters.length} nhân vật được khôi phục.`);
      showToast('Đã nạp dự án truyện!', 'ready');
    } catch (err) {
      showToast(`Không thể đọc dự án: ${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  });
}

// Story: Generate
const storyGenerateBtn = document.getElementById('story-generate');
if (storyGenerateBtn) {
  storyGenerateBtn.addEventListener('click', async () => {
    const text = document.getElementById('story-text').value.trim();
    const narratorVoice = document.getElementById('story-narrator-voice').value;
    if (!text) { showToast('Hãy dán nội dung truyện trước.'); return; }
    if (!narratorVoice) { showToast('Hãy chọn giọng người kể chuyện.'); return; }
    const characterVoices = {};
    document.querySelectorAll('.story-character-voice-select').forEach((sel) => {
      characterVoices[sel.dataset.character] = sel.value;
    });
    startBackgroundJob({
      endpoint: '/jobs/story',
      payload: { text, narrator_voice: narratorVoice, character_voices: characterVoices },
      progressBlockId: 'story-progress',
      generateBtn: storyGenerateBtn,
      generateBtnText: '▶ Tạo audiobook',
      resultPrefix: 'story',
      historyTitle: `Truyện (${storyCharacters.length} nhân vật)`,
      historySub: `Người kể: ${narratorVoice}`
    });
  });
}

// =====================================================
// Dubbing & Video tab
// =====================================================
let dubMode = 'srt';
const dubCuesByMode = { srt: [], audio: [], video: [] };
const dubStatusByMode = { srt: '', audio: '', video: '' };
let dubAudioB64 = null;
let dubVideoB64 = null;
let muxMode = 'replace';

// Mode switch
document.querySelectorAll('#dub-mode-switch .mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetMode = btn.dataset.mode;
    if (targetMode === dubMode) return;
    dubMode = targetMode;
    document.querySelectorAll('#dub-mode-switch .mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('dub-mode-srt').style.display = dubMode === 'srt' ? '' : 'none';
    document.getElementById('dub-mode-audio').style.display = dubMode === 'audio' ? '' : 'none';
    document.getElementById('dub-mode-video').style.display = dubMode === 'video' ? '' : 'none';
    renderDubCuePreview();
    const currentCues = dubCuesByMode[dubMode] || [];
    document.getElementById('dub-generate').disabled = (currentCues.length === 0);
  });
});

function renderDubCuePreview() {
  const currentCues = dubCuesByMode[dubMode] || [];
  const fmt = (ms) => {
    const s = Math.floor(ms / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  };

  const html = currentCues.length === 0 ? '' : currentCues.map((c) => `
    <div class="dub-cue-row">
      <span class="dub-cue-time">⏱️ ${fmt(c.start_ms)} – ${fmt(c.end_ms)}</span>
      <span class="dub-cue-text">${escapeHtml(c.text)}</span>
    </div>
  `).join('');

  const srtContainer = document.getElementById('dub-cue-preview');
  const audioContainer = document.getElementById('dub-audio-cue-preview');

  if (srtContainer && dubMode === 'srt') srtContainer.innerHTML = html;
  if (audioContainer && dubMode === 'audio') audioContainer.innerHTML = html;
}

// SRT mode
document.getElementById('dub-srt-load-file').addEventListener('click', () => document.getElementById('dub-srt-file-input').click());
document.getElementById('dub-srt-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  document.getElementById('dub-srt-text').value = text;
});

// Dub SRT Project Save
document.getElementById('dub-srt-save-project').addEventListener('click', () => {
  const srtText = document.getElementById('dub-srt-text').value.trim();
  if (!srtText) { showToast('Nội dung SRT đang trống.'); return; }
  const voice = document.getElementById('dub-voice').value;
  const projectData = {
    type: 'vieneu-dub-project', version: 1,
    exported_at: new Date().toISOString(),
    mode: 'srt', srt_text: srtText,
    voice, cues: dubCuesByMode['srt'] || []
  };
  downloadJSON(projectData, `du_an_phu_de_srt_${Date.now()}.json`);
  showToast('Đã xuất file dự án kịch bản SRT (.json)!', 'ready');
});

// Dub SRT Project Load
document.getElementById('dub-srt-load-project').addEventListener('click', () => document.getElementById('dub-project-file-input').click());
document.getElementById('dub-project-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const raw = await file.text();
    const project = JSON.parse(raw);
    if (project.type !== 'vieneu-dub-project' && !project.srt_text) throw new Error('Định dạng tệp không hợp lệ.');
    document.getElementById('dub-srt-text').value = project.srt_text || '';
    if (project.voice) document.getElementById('dub-voice').value = project.voice;
    dubCuesByMode['srt'] = project.cues || [];
    renderDubCuePreview();
    const statusEl = document.getElementById('dub-srt-status');
    statusEl.textContent = `Đã nạp dự án: ${dubCuesByMode['srt'].length} đoạn phụ đề.`;
    statusEl.className = 'settings-status';
    document.getElementById('dub-generate').disabled = (dubCuesByMode['srt'].length === 0);
    showToast('Đã nạp dự án phụ đề SRT!', 'ready');
  } catch (err) {
    showToast(`Không thể đọc dự án: ${err.message}`, 'error');
  } finally {
    e.target.value = '';
  }
});

// SRT parse
document.getElementById('dub-srt-parse').addEventListener('click', async () => {
  const srtText = document.getElementById('dub-srt-text').value.trim();
  if (!srtText) { showToast('Hãy dán hoặc nhập nội dung phụ đề SRT trước.'); return; }
  const statusEl = document.getElementById('dub-srt-status');
  statusEl.textContent = 'Đang kiểm tra…';
  statusEl.className = 'settings-status pending';
  document.getElementById('dub-generate').disabled = true;
  try {
    const res = await fetch(`${BACKEND_URL}/dub/parse-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srt_text: srtText, voice: '' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Lỗi không xác định');
    dubCuesByMode['srt'] = data.cues || [];
    renderDubCuePreview();
    statusEl.textContent = `Tìm thấy ${data.cue_count} đoạn phụ đề. Chọn giọng rồi tạo lồng tiếng.`;
    statusEl.className = 'settings-status';
    document.getElementById('dub-generate').disabled = false;
  } catch (e) {
    statusEl.textContent = `Lỗi: ${e.message}`;
    statusEl.className = 'settings-status error';
    dubCuesByMode['srt'] = [];
    renderDubCuePreview();
  }
});

// Audio mode
document.getElementById('dub-audio-load-file').addEventListener('click', () => document.getElementById('dub-audio-file-input').click());
document.getElementById('dub-audio-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  document.getElementById('dub-audio-filename').textContent = file ? file.name : '';
  document.getElementById('dub-audio-parse').disabled = !file;
  if (!file) { dubAudioB64 = null; return; }
  const buf = await file.arrayBuffer();
  dubAudioB64 = arrayBufferToBase64(buf);
});

document.getElementById('dub-audio-parse').addEventListener('click', async () => {
  if (!dubAudioB64) { showToast('Hãy chọn tệp âm thanh trước.'); return; }
  const statusEl = document.getElementById('dub-audio-status');
  statusEl.textContent = 'Đang phiên âm… (lần đầu có thể mất vài phút)';
  statusEl.className = 'settings-status pending';
  document.getElementById('dub-generate').disabled = true;
  try {
    const res = await fetch(`${BACKEND_URL}/dub/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_b64: dubAudioB64, voice: '', language: 'vi' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Lỗi không xác định');
    dubCuesByMode['audio'] = data.cues || [];
    renderDubCuePreview();
    statusEl.textContent = `Phiên âm xong: ${data.cue_count} đoạn. Chọn giọng rồi tạo lồng tiếng.`;
    statusEl.className = 'settings-status';
    document.getElementById('dub-generate').disabled = false;
  } catch (e) {
    statusEl.textContent = `Lỗi: ${e.message}`;
    statusEl.className = 'settings-status error';
    dubCuesByMode['audio'] = [];
    renderDubCuePreview();
  }
});

// Video Mux mode
document.getElementById('dub-video-load-file').addEventListener('click', () => document.getElementById('dub-video-file-input').click());
document.getElementById('dub-video-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  document.getElementById('dub-video-filename').textContent = file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)` : 'Chưa chọn video';
  if (!file) { dubVideoB64 = null; updateMuxButtonState(); return; }
  const buf = await file.arrayBuffer();
  dubVideoB64 = arrayBufferToBase64(buf);
  updateMuxButtonState();
});

document.querySelectorAll('[data-mux-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-mux-mode]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    muxMode = btn.dataset.muxMode;
    document.getElementById('mux-volume-controls').style.display = muxMode === 'mix' ? 'block' : 'none';
  });
});

const volOrigSlider = document.getElementById('mux-vol-orig');
const volOrigVal = document.getElementById('mux-vol-orig-val');
if (volOrigSlider) volOrigSlider.oninput = () => { if (volOrigVal) volOrigVal.textContent = `${Math.round(volOrigSlider.value * 100)}%`; };

const volDubSlider = document.getElementById('mux-vol-dub');
const volDubVal = document.getElementById('mux-vol-dub-val');
if (volDubSlider) volDubSlider.oninput = () => { if (volDubVal) volDubVal.textContent = `${Math.round(volDubSlider.value * 100)}%`; };

function updateMuxButtonState() {
  const btn = document.getElementById('dub-video-mux-btn');
  const hasVideo = !!dubVideoB64;
  const hasAudio = !!lastDubAudioFilename;
  if (btn) btn.disabled = !(hasVideo && hasAudio);
}

document.getElementById('dub-video-mux-btn').addEventListener('click', async () => {
  if (!dubVideoB64) { showToast('Hãy tải file video lên trước.'); return; }
  if (!lastDubAudioFilename) { showToast('Chưa có track âm thanh lồng tiếng. Hãy bấm "Tạo lồng tiếng" trước.'); return; }
  const btn = document.getElementById('dub-video-mux-btn');
  const statusEl = document.getElementById('dub-video-status');
  const hardsubCheckbox = document.getElementById('mux-hardsub-checkbox');
  const burnSubtitles = hardsubCheckbox ? hardsubCheckbox.checked : false;
  const srtText = document.getElementById('dub-srt-text') ? document.getElementById('dub-srt-text').value.trim() : '';
  btn.disabled = true;
  statusEl.textContent = burnSubtitles ? 'Đang ghép video, in phụ đề (hardsub)…' : 'Đang ghép video qua FFmpeg…';
  statusEl.className = 'settings-status pending';
  try {
    const res = await fetch(`${BACKEND_URL}/video/mux`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_b64: dubVideoB64,
        audio_filename: lastDubAudioFilename,
        mode: muxMode,
        original_volume: parseFloat(volOrigSlider ? volOrigSlider.value : 0.2),
        dub_volume: parseFloat(volDubSlider ? volDubSlider.value : 1.0),
        burn_subtitles: burnSubtitles,
        srt_text: burnSubtitles ? srtText : null
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Ghép video thất bại');
    statusEl.textContent = 'Đã ghép video' + (burnSubtitles ? ' kèm phụ đề hardsub' : '') + ' thành công!';
    statusEl.className = 'settings-status';
    const videoUrl = `${BACKEND_URL}${data.video_url}`;
    document.getElementById('video-preview-wrap').style.display = 'block';
    document.getElementById('dubbed-video-player').src = videoUrl;
    document.getElementById('dubbed-video-download').href = videoUrl;
    showToast('Ghép video thành công!', 'ready');
  } catch (err) {
    statusEl.textContent = `Lỗi: ${err.message}`;
    statusEl.className = 'settings-status error';
    showToast(`Không thể ghép video: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

// Dub generate (SRT/Audio modes)
document.getElementById('dub-generate').addEventListener('click', async () => {
  const btn = document.getElementById('dub-generate');
  const voice = document.getElementById('dub-voice').value;
  const currentCues = dubCuesByMode[dubMode] || [];
  if (!voice) { showToast('Hãy chọn giọng lồng tiếng.'); return; }
  if (currentCues.length === 0) { showToast('Hãy kiểm tra phụ đề / phiên âm trước khi tạo.'); return; }
  let endpoint, payload;
  if (dubMode === 'srt') {
    const srtText = document.getElementById('dub-srt-text').value.trim();
    endpoint = '/jobs/dub-srt';
    payload = { srt_text: srtText, voice };
  } else {
    endpoint = '/jobs/dub-audio';
    payload = { audio_b64: dubAudioB64, voice, language: 'vi' };
  }
  startBackgroundJob({
    endpoint, payload,
    progressBlockId: 'dub-progress',
    generateBtn: btn,
    generateBtnText: '▶ Tạo lồng tiếng',
    resultPrefix: 'dub',
    historyTitle: `Lồng tiếng (${currentCues.length} đoạn)`,
    historySub: `Giọng: ${voice}`,
    onComplete: (data) => {
      if (data.file_path) {
        lastDubAudioFilename = data.filename || getFilenameFromPath(data.file_path);
        updateMuxButtonState();
      }
    }
  });
});

// =====================================================
// Conversation Studio (Hội thoại nhiều giọng)
// =====================================================


function initConvoModule() {
  // Update sidebar voice count
  const countEl = document.getElementById('ctrl-convo-voice-count');
  if (countEl) countEl.textContent = `Giọng nói (${voices.length})`;

  // Subtab navigation buttons
  document.querySelectorAll('[data-studio-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.studioNav;
      switchNav(target);
    });
  });

  // Pause slider
  const pauseSlider = document.getElementById('convo-pause-slider');
  const pauseVal = document.getElementById('convo-pause-val');
  if (pauseSlider) {
    pauseSlider.addEventListener('input', (e) => {
      if (pauseVal) pauseVal.textContent = `${e.target.value}MS`;
    });
  }

  // Speed reset
  const speedInput = document.getElementById('convo-speed-input');
  const speedReset = document.getElementById('convo-speed-reset');
  if (speedReset && speedInput) {
    speedReset.addEventListener('click', () => {
      speedInput.value = '1.0';
      showToast('Đã đặt lại tốc độ 1.0x', 'ready');
    });
  }

  // Temp slider
  const tempSlider = document.getElementById('convo-temp-slider');
  const tempVal = document.getElementById('convo-temp-val');
  if (tempSlider) {
    tempSlider.addEventListener('input', (e) => {
      if (tempVal) tempVal.textContent = parseFloat(e.target.value).toFixed(2);
    });
  }

  // Add turn button
  const addTurnBtn = document.getElementById('convo-add-turn-btn');
  if (addTurnBtn) {
    addTurnBtn.addEventListener('click', () => {
      if (convoTurns.length >= 50) {
        showToast('Số lượt thoại tối đa là 50.', 'error');
        return;
      }
      const newIdx = convoTurns.length + 1;
      const prevVoice = convoTurns.length > 0 ? convoTurns[convoTurns.length - 1].voice : '';
      let nextVoice = prevVoice;
      if (voices.length > 1) {
        const alt = voices.find(v => v.id !== prevVoice);
        if (alt) nextVoice = alt.id;
      }
      convoTurns.push({
        id: 'turn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        speaker: `Người nói ${newIdx}`,
        voice: nextVoice || (voices[0] ? voices[0].id : ''),
        text: '',
        speed: 1.0
      });
      renderConvoTurns();
    });
  }

  // Clear all button
  const clearAllBtn = document.getElementById('convo-clear-all-btn');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      if (confirm('Bạn có chắc chắn muốn xóa tất cả lượt thoại?')) {
        convoTurns = [];
        renderConvoTurns();
      }
    });
  }

  // Generate conversation button
  const genBtn = document.getElementById('convo-generate-btn');
  if (genBtn) {
    genBtn.addEventListener('click', () => {
      generateConversation();
    });
  }

  // Script parser modal
  const modal = document.getElementById('convo-script-modal');
  const smartParseBtn = document.getElementById('convo-smart-parse-btn');
  const closeBtn = document.getElementById('convo-modal-close-btn');
  const cancelBtn = document.getElementById('convo-modal-cancel-btn');
  const parseBtn = document.getElementById('convo-modal-parse-btn');
  const applyBtn = document.getElementById('convo-modal-apply-btn');

  if (smartParseBtn) smartParseBtn.addEventListener('click', () => { if (modal) modal.style.display = 'flex'; });
  if (closeBtn) closeBtn.addEventListener('click', () => { if (modal) modal.style.display = 'none'; });
  if (cancelBtn) cancelBtn.addEventListener('click', () => { if (modal) modal.style.display = 'none'; });

  if (parseBtn) {
    parseBtn.addEventListener('click', async () => {
      const scriptText = document.getElementById('convo-modal-script-text').value.trim();
      if (!scriptText) {
        showToast('Vui lòng dán nội dung kịch bản trước.', 'error');
        return;
      }
      try {
        const res = await fetch(`${BACKEND_URL}/conversation/parse-script`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script_text: scriptText })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Lỗi phân tích kịch bản');
        parsedScriptData = data;

        const wrap = document.getElementById('convo-modal-speakers-wrap');
        const list = document.getElementById('convo-modal-speakers-list');
        if (wrap && list) {
          wrap.style.display = 'flex';
          list.innerHTML = data.speakers.map((spk, idx) => {
            const defaultVoice = voices[idx % voices.length] ? voices[idx % voices.length].id : '';
            return `
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; background:var(--bg-card); padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--border);">
                <span style="font-weight:600; font-size:13px; color:var(--text-primary);">🎭 ${escapeHtml(spk)}</span>
                <select class="select convo-modal-speaker-select" data-speaker="${escapeHtml(spk)}" style="min-width:220px; font-size:12.5px;">
                  ${voices.map(v => `<option value="${v.id}" ${v.id === defaultVoice ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
                </select>
              </div>
            `;
          }).join('');
        }
        showToast(`Tìm thấy ${data.speakers.length} nhân vật và ${data.total_turns} lượt thoại!`, 'ready');
      } catch (err) {
        showToast('Lỗi phân tích: ' + err.message, 'error');
      }
    });
  }

  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      if (!parsedScriptData || !parsedScriptData.turns || parsedScriptData.turns.length === 0) {
        showToast('Vui lòng bấm "Phân tích nhân vật" trước.', 'error');
        return;
      }
      const speakerMap = {};
      document.querySelectorAll('.convo-modal-speaker-select').forEach(sel => {
        speakerMap[sel.dataset.speaker] = sel.value;
      });

      convoTurns = parsedScriptData.turns.map((t, idx) => ({
        id: 'turn_' + Date.now() + '_' + idx,
        speaker: t.speaker,
        voice: speakerMap[t.speaker] || (voices[0] ? voices[0].id : ''),
        text: t.text,
        speed: 1.0
      }));

      renderConvoTurns();
      if (modal) modal.style.display = 'none';
      showToast(`Đã nạp thành công ${convoTurns.length} lượt thoại vào phòng thu!`, 'ready');
    });
  }

  renderConvoTurns();
}

function renderConvoTurns() {
  const container = document.getElementById('convo-turns-list');
  const countEl = document.getElementById('convo-turn-count');
  if (countEl) countEl.textContent = convoTurns.length;

  if (!container) return;

  if (convoTurns.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px 20px; background:var(--bg-card); border:1px dashed var(--border); border-radius:var(--radius-md);">
        <p style="color:var(--text-muted); font-size:14px; margin-bottom:12px;">Chưa có lượt thoại nào trong kịch bản.</p>
        <button class="btn btn-primary btn-sm" onclick="document.getElementById('convo-add-turn-btn').click()">➕ Thêm lượt thoại đầu tiên</button>
      </div>
    `;
    return;
  }

  container.innerHTML = convoTurns.map((turn, idx) => {
    const curVoiceId = turn.voice || (voices[idx % voices.length] ? voices[idx % voices.length].id : (voices[0] ? voices[0].id : ''));
    turn.voice = curVoiceId;

    return `
      <div class="convo-turn-card" data-turn-id="${turn.id}" id="card-${turn.id}">
        <div class="convo-turn-header">
          <div class="convo-turn-badge">${idx + 1}</div>
          <div class="convo-turn-voice-wrap">
            <select class="select convo-voice-select" id="select-${turn.id}">
              ${voices.map(v => `<option value="${v.id}" ${v.id === curVoiceId ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
            </select>
          </div>
          <div class="convo-turn-speed" title="Tốc độ lượt thoại này">
            <span>⚡</span>
            <input type="number" class="convo-speed-val" min="0.5" max="2.0" step="0.05" value="${turn.speed || 1.0}" />
            <span>x</span>
          </div>
          <div class="convo-turn-actions">
            <button class="convo-turn-btn convo-preview-turn-btn" title="Nghe thử câu này">🎧 Nghe thử</button>
            <button class="convo-turn-btn delete convo-delete-turn-btn" title="Xóa lượt này">🗑️</button>
          </div>
        </div>
        <textarea class="convo-turn-textarea" placeholder="Nội dung lượt thoại...">${escapeHtml(turn.text)}</textarea>
        <div class="convo-cues-row">
          <span style="font-size:11px; color:var(--text-muted); margin-right:4px;">Cảm xúc:</span>
          <span class="convo-cue-chip" data-cue="[cười]">😄 Cười</span>
          <span class="convo-cue-chip" data-cue="[thở dài]">😮💨 Thở dài</span>
          <span class="convo-cue-chip" data-cue="[hắng giọng]">🗣️ Hắng giọng</span>
          <span class="convo-cue-chip" data-cue="[thì thầm]">🤫 Thì thầm</span>
          <span class="convo-cue-chip" data-cue="[ngạc nhiên]">😲 Ngạc nhiên</span>
          <span class="convo-cue-chip" data-cue="[tức giận]">😠 Tức giận</span>
        </div>
      </div>
    `;
  }).join('');

  // Setup interactive comboboxes and event listeners for each turn card
  convoTurns.forEach((turn, idx) => {
    const card = document.getElementById(`card-${turn.id}`);
    if (!card) return;

    setupSearchableVoiceSelect(`select-${turn.id}`);

    const selectEl = document.getElementById(`select-${turn.id}`);
    if (selectEl) {
      selectEl.addEventListener('change', (e) => {
        turn.voice = e.target.value;
      });
    }

    const textarea = card.querySelector('.convo-turn-textarea');
    if (textarea) {
      textarea.addEventListener('input', (e) => {
        turn.text = e.target.value;
      });
    }

    const speedInput = card.querySelector('.convo-speed-val');
    if (speedInput) {
      speedInput.addEventListener('change', (e) => {
        turn.speed = parseFloat(e.target.value) || 1.0;
      });
    }

    // Cue chips
    card.querySelectorAll('.convo-cue-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const cue = chip.dataset.cue;
        if (!textarea) return;
        const start = textarea.selectionStart || textarea.value.length;
        const end = textarea.selectionEnd || textarea.value.length;
        const before = textarea.value.substring(0, start);
        const after = textarea.value.substring(end);
        textarea.value = before + (before.length && !before.endsWith(' ') ? ' ' : '') + cue + ' ' + after;
        turn.text = textarea.value;
        textarea.focus();
      });
    });

    // Delete button
    const deleteBtn = card.querySelector('.convo-delete-turn-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        convoTurns = convoTurns.filter(t => t.id !== turn.id);
        renderConvoTurns();
      });
    }

    // Preview button
    const previewBtn = card.querySelector('.convo-preview-turn-btn');
    if (previewBtn) {
      previewBtn.addEventListener('click', async () => {
        const text = textarea ? textarea.value.trim() : turn.text.trim();
        if (!text) {
          showToast('Vui lòng nhập nội dung trước khi nghe thử.', 'error');
          return;
        }
        previewBtn.disabled = true;
        previewBtn.textContent = '⏳ Đang tạo...';
        try {
          const res = await fetch(`${BACKEND_URL}/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              voice: turn.voice,
              speed: turn.speed || 1.0
            })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || 'Lỗi tạo thử');
          const audioUrl = `${BACKEND_URL}${data.audio_url}`;
          const aud = new Audio(audioUrl);
          aud.play();
          showToast('Đang phát lượt thoại nghe thử!', 'ready');
        } catch (err) {
          showToast('Không thể nghe thử: ' + err.message, 'error');
        } finally {
          previewBtn.disabled = false;
          previewBtn.textContent = '🎧 Nghe thử';
        }
      });
    }
  });
}

function renderConvoSpeakerVoices() {
  renderConvoTurns();
}

async function generateConversation() {
  const validTurns = convoTurns.filter(t => t.text.trim().length > 0);
  if (validTurns.length === 0) {
    showToast('Chưa có lượt thoại nào có nội dung. Vui lòng nhập lời thoại.', 'error');
    return;
  }

  const pauseSlider = document.getElementById('convo-pause-slider');
  const speedInput = document.getElementById('convo-speed-input');
  const tempSlider = document.getElementById('convo-temp-slider');

  const pauseMs = pauseSlider ? parseInt(pauseSlider.value, 10) : 500;
  const speed = speedInput ? parseFloat(speedInput.value) : 1.0;
  const temp = tempSlider ? parseFloat(tempSlider.value) : 0.8;

  const btn = document.getElementById('convo-generate-btn');
  const payload = {
    lines: validTurns.map(t => ({
      speaker: t.speaker || 'Người nói',
      voice: t.voice,
      text: t.text.trim(),
      speed: t.speed || speed
    })),
    gap_ms: pauseMs,
    pause_ms: pauseMs,
    speed: speed,
    temperature: temp
  };

  startBackgroundJob({
    endpoint: '/jobs/conversation',
    payload: payload,
    progressBlockId: 'convo-progress',
    generateBtn: btn,
    generateBtnText: '💬 Tạo hội thoại',
    resultPrefix: 'convo',
    historyTitle: `Hội thoại (${validTurns.length} lượt thoại)`,
    historySub: `Khoảng lặng: ${pauseMs}ms · Tốc độ: ${speed}x`,
    onComplete: (data) => {
      const resultCard = document.getElementById('convo-result-card');
      const audioEl = document.getElementById('convo-audio');
      const downloadEl = document.getElementById('convo-download');
      if (resultCard && audioEl && data.audio_url) {
        resultCard.style.display = 'block';
        audioEl.src = `${BACKEND_URL}${data.audio_url}`;
        if (downloadEl) downloadEl.href = `${BACKEND_URL}${data.audio_url}`;
      }
    }
  });
}

// =====================================================
// Voice Library — renderLibrary (VieNeu native voices)
// =====================================================
const GENDER_LABEL = { nam: 'Nam', nu: 'Nữ', chua_ro: '' };
const REGION_LABEL = { bac: 'Miền Bắc', trung: 'Miền Trung', nam: 'Miền Nam', chua_ro: '' };
const GENDER_ICON  = { nam: '👨', nu: '👩', chua_ro: '' };

let libFilters = { gender: 'all', region: 'all' };
let libSearch = '';

const libSearchEl = document.getElementById('lib-search');
if (libSearchEl) {
  libSearchEl.addEventListener('input', (e) => {
    libSearch = e.target.value.trim().toLowerCase();
    renderLibrary();
  });
}

// Filter chips for VieNeu library (gender & region)
// Use event delegation on the parent to avoid selector scope issues
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip[data-filter]');
  if (!chip) return;
  const group = chip.dataset.filter;  // 'gender' or 'region'
  const val   = chip.dataset.value;   // 'all', 'nu', 'nam', 'bac', etc.

  // Deactivate siblings in same group, activate clicked chip
  document.querySelectorAll(`.filter-chip[data-filter="${group}"]`).forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  libFilters[group] = val;
  renderLibrary();
});

function renderLibrary() {
  const list    = document.getElementById('lib-list');
  const countEl = document.getElementById('lib-count');
  if (!list) return;

  // Only show VieNeu native voices (not piper)
  const nativeVoices = voices.filter(v => {
    const vid = String(v.id || '');
    return !vid.startsWith('piper:') && !vid.startsWith('custom:');
  });

  const filtered = nativeVoices.filter((v) => {
    // Search by name/label
    if (libSearch) {
      const haystack = `${v.label} ${v.name || ''} ${v.id}`.toLowerCase();
      if (!haystack.includes(libSearch)) return false;
    }
    // Gender filter — strictly match selected gender
    if (libFilters.gender !== 'all') {
      if (v.gender !== libFilters.gender) return false;
    }
    // Region filter — strictly match selected region
    if (libFilters.region !== 'all') {
      if (v.region !== libFilters.region) return false;
    }
    return true;
  });

  if (countEl) countEl.textContent = `${filtered.length} / ${nativeVoices.length} giọng`;

  if (nativeVoices.length === 0) {
    list.innerHTML = `
      <div style="text-align:center; padding:48px 24px; color:var(--text-muted);">
        <div style="font-size:40px; margin-bottom:12px;">🎙️</div>
        <p style="font-size:14px; font-weight:600; color:var(--text-secondary); margin-bottom:6px;">Chưa có giọng nào được tải</p>
        <p style="font-size:12.5px;">Engine đang khởi động hoặc chưa tải xong danh sách giọng.</p>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    list.innerHTML = '<p class="empty-note">Không tìm thấy giọng phù hợp bộ lọc.</p>';
    return;
  }

  list.innerHTML = filtered.map((v) => {
    const genderLabel = GENDER_LABEL[v.gender] || '';
    const genderIcon  = GENDER_ICON[v.gender]  || '';
    const regionLabel = REGION_LABEL[v.region] || v.region_name || '';
    // Clean display name: use v.name directly, or strip prefix/tags from label
    let displayName = v.name || v.label || v.id;
    if (!v.name && v.label) {
      // Remove leading icon characters and [tag] patterns
      displayName = v.label
        .replace(/^\s*[\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF\s]+/, '')
        .replace(/\s*\[.*?\]\s*/g, '')
        .trim() || v.label;
    }

    return `
      <div class="lib-item" data-voice-id="${escapeHtml(v.id)}">
        <div class="lib-item-left">
          <button class="lib-play" data-voice-id="${escapeHtml(v.id)}" title="Nghe thử">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
        </div>
        <div class="lib-info">
          <span class="lib-name">${escapeHtml(displayName)}</span>
          <div class="lib-tags">
            ${genderLabel ? `<span class="lib-tag gender-tag">${genderIcon} ${genderLabel}</span>` : ''}
            ${regionLabel ? `<span class="lib-tag region-tag">${escapeHtml(regionLabel)}</span>` : ''}
            <span class="lib-tag engine-tag">VieNeu 48kHz</span>
          </div>
        </div>
        <button class="lib-use-btn" data-voice-id="${escapeHtml(v.id)}">Dùng</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.lib-play').forEach((btn) => {
    btn.addEventListener('click', () => playVoicePreviewLib(btn));
  });
  list.querySelectorAll('.lib-use-btn').forEach((btn) => {
    btn.addEventListener('click', () => useVoiceInStudio(btn.dataset.voiceId));
  });
}

async function playVoicePreviewLib(btn) {
  const voiceId = btn.dataset.voiceId;

  // Stop any currently playing preview
  if (currentPreviewAudio) {
    currentPreviewAudio.pause();
    currentPreviewAudio = null;
    if (currentPreviewBtn && currentPreviewBtn !== btn) {
      currentPreviewBtn.classList.remove('playing');
      currentPreviewBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    }
  }

  if (currentPreviewBtn === btn) {
    currentPreviewBtn = null;
    btn.classList.remove('playing');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    return;
  }

  btn.classList.add('playing');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  currentPreviewBtn = btn;

  const audio = new Audio(`${BACKEND_URL}/voices/${encodeURIComponent(voiceId)}/preview`);
  currentPreviewAudio = audio;

  audio.play().catch((e) => {
    showToast('Không phát được bản nghe thử: ' + e.message, 'error');
    btn.classList.remove('playing');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    currentPreviewBtn = null;
    currentPreviewAudio = null;
  });

  audio.onended = () => {
    btn.classList.remove('playing');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    currentPreviewBtn = null;
    currentPreviewAudio = null;
  };
}

function useVoiceInStudio(voiceId) {
  document.getElementById('studio-voice').value = voiceId;
  switchNav('studio');
  showToast(`Đã chọn giọng vào Phòng thu.`, 'ready');
}

// =====================================================
// Piper ONNX Catalog & Subtab Controller
// =====================================================
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.mode-btn[data-lib-tab]');
  if (!tab) return;
  
  const tabKey = tab.dataset.libTab;
  const libTabVieneu = document.getElementById('lib-tab-vieneu');
  const libTabPiper = document.getElementById('lib-tab-piper');
  const libSecVieneu = document.getElementById('lib-sec-vieneu');
  const libSecPiper = document.getElementById('lib-sec-piper');

  if (tabKey === 'vieneu') {
    if (libTabVieneu) libTabVieneu.classList.add('active');
    if (libTabPiper) libTabPiper.classList.remove('active');
    if (libSecVieneu) libSecVieneu.style.display = 'block';
    if (libSecPiper) libSecPiper.style.display = 'none';
  } else if (tabKey === 'piper') {
    if (libTabPiper) libTabPiper.classList.add('active');
    if (libTabVieneu) libTabVieneu.classList.remove('active');
    if (libSecVieneu) libSecVieneu.style.display = 'none';
    if (libSecPiper) libSecPiper.style.display = 'block';
    if (typeof loadPiperCatalog === 'function') loadPiperCatalog();
  }
});

const piperImportBtn = document.getElementById('piper-import-btn');
const piperFileInput = document.getElementById('piper-file-input');

if (piperImportBtn) {
  piperImportBtn.addEventListener('click', async () => {
    try {
      if (window.vieneu && window.vieneu.importVoiceFiles) {
        const res = await window.vieneu.importVoiceFiles();
        if (res && res.success && res.count > 0) {
          await loadPiperCatalog();
          await loadVoices();
          showToast(`Đã thêm thành công ${res.count} giọng đọc: ${res.names.join(', ')}`, 'ready');
        }
      } else if (piperFileInput) {
        piperFileInput.click();
      }
    } catch (e) {
      showToast('Lỗi khi thêm giọng đọc: ' + e.message, 'error');
    }
  });
}

if (piperFileInput) {
  piperFileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));

    try {
      showToast('Đang sao chép file model...', 'busy');
      const res = await fetch(`${BACKEND_URL}/piper/import-files`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Lỗi tải file');
      await loadPiperCatalog();
      await loadVoices();
      showToast('Đã thêm thành công giọng đọc vào ứng dụng!', 'ready');
    } catch (err) {
      showToast('Lỗi khi nạp file: ' + err.message, 'error');
    } finally {
      piperFileInput.value = '';
    }
  });
}

const piperOpenFolderBtn = document.getElementById('piper-open-folder-btn');
if (piperOpenFolderBtn) {
  piperOpenFolderBtn.addEventListener('click', async () => {
    try {
      if (window.vieneu && window.vieneu.openFolder) {
        await window.vieneu.openFolder();
      } else {
        const res = await fetch(`${BACKEND_URL}/piper/open-folder`, { method: 'POST' });
        if (!res.ok) throw new Error('Không thể mở thư mục');
      }
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

const piperRefreshBtn = document.getElementById('piper-refresh-btn');
if (piperRefreshBtn) {
  piperRefreshBtn.addEventListener('click', async () => {
    await loadPiperCatalog();
    await loadVoices();
    showToast('Đã làm mới danh sách giọng!', 'ready');
  });
}

let currentPiperRegion = 'all';
let currentPiperGender = 'all';
let currentPiperStatus = 'all';
let currentPiperSearch = '';

const piperSearchInput = document.getElementById('piper-search-input');
if (piperSearchInput) {
  piperSearchInput.addEventListener('input', (e) => {
    currentPiperSearch = e.target.value.trim().toLowerCase();
    loadPiperCatalog();
  });
}

document.addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;

  if (chip.dataset.regionFilter) {
    document.querySelectorAll('#piper-region-filter-row .filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentPiperRegion = chip.dataset.regionFilter;
    loadPiperCatalog();
  } else if (chip.dataset.genderFilter) {
    document.querySelectorAll('#piper-gender-filter-row .filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentPiperGender = chip.dataset.genderFilter;
    loadPiperCatalog();
  } else if (chip.dataset.statusFilter) {
    document.querySelectorAll('#piper-status-filter-row .filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentPiperStatus = chip.dataset.statusFilter;
    loadPiperCatalog();
  }
});

async function loadPiperCatalog() {
  const container = document.getElementById('piper-catalog-list');
  if (!container) return;
  container.innerHTML = '<p class="empty-note">Đang tải danh mục model ONNX…</p>';

  try {
    const res = await fetch(`${BACKEND_URL}/piper/catalog`);
    if (!res.ok) throw new Error('Không thể tải catalog Piper');
    let items = await res.json();

    if (!items || items.length === 0) {
      container.innerHTML = '<p class="empty-note">Chưa có model nào trong danh mục.</p>';
      return;
    }

    // Apply Region / Accent filter
    if (currentPiperRegion === 'international') {
      items = items.filter(it => ['fr', 'de', 'es', 'it', 'zh', 'ja', 'ko'].includes(it.lang) || ['fr', 'de', 'es', 'it', 'zh'].includes(it.region));
    } else if (currentPiperRegion !== 'all') {
      items = items.filter(it => it.region === currentPiperRegion || it.accent === currentPiperRegion);
    }
    // Apply Gender filter
    if (currentPiperGender !== 'all') {
      items = items.filter(it => it.gender === currentPiperGender);
    }
    // Apply Status filter
    if (currentPiperStatus === 'downloaded') {
      items = items.filter(it => it.is_downloaded);
    } else if (currentPiperStatus === 'available') {
      items = items.filter(it => !it.is_downloaded);
    }
    // Apply Search keyword
    if (currentPiperSearch) {
      items = items.filter(it => {
        const text = `${it.name} ${it.desc || ''} ${it.region_name || ''} ${it.accent_name || ''} ${it.style || ''}`.toLowerCase();
        return text.includes(currentPiperSearch);
      });
    }

    const countEl = document.getElementById('piper-filtered-count');
    if (countEl) countEl.textContent = `Tìm thấy ${items.length} giọng`;

    if (items.length === 0) {
      container.innerHTML = '<p class="empty-note">Không tìm thấy giọng đọc nào khớp với tiêu chí lọc.</p>';
      return;
    }

    container.innerHTML = items.map((item) => {
      const isDl = item.is_downloaded;
      const isEn = item.lang === 'en' || String(item.region).startsWith('us') || String(item.region).startsWith('uk');
      const regBadge = item.region_name || item.accent_name || (item.region === 'bac' ? 'Miền Bắc' : (item.region === 'nam' ? 'Miền Nam' : item.region));
      const genderLabel = item.gender === 'nu' ? 'Nữ' : 'Nam';

      return `
        <div class="settings-card" style="margin-bottom:0; display:flex; flex-direction:column; justify-content:space-between; gap:10px; border:1px solid ${isDl ? 'var(--accent)' : 'var(--border)'};">
          <div>
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
              <span style="font-size:14px; font-weight:700; color:var(--text-primary);">${isEn ? '🗣️' : '⚡'} ${escapeHtml(item.name)}</span>
              <span class="lib-gender" style="font-size:11px;">${genderLabel} · ${escapeHtml(regBadge)}</span>
            </div>
            <p style="font-size:12px; color:var(--text-muted); margin:6px 0 0; line-height:1.4;">${escapeHtml(item.desc)}</p>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border); padding-top:8px; margin-top:4px;">
            <span style="font-size:11px; color:${isDl ? 'var(--accent)' : 'var(--text-muted)'}; font-weight:500;">
              ${isDl ? `✅ Đã sẵn sàng (${item.size_mb || '60'} MB)` : 'Chưa tải'}
            </span>
            <div style="display:flex; gap:6px;">
              ${isDl ? `
                <button class="btn btn-ghost btn-sm piper-preview-btn" data-voice-id="piper:${item.id}" title="Nghe thử">▶ Thử</button>
                <button class="btn btn-primary btn-sm piper-use-btn" data-voice-id="piper:${item.id}">Dùng</button>
                <button class="btn btn-ghost btn-sm piper-del-btn" data-model-id="${item.id}" style="color:#ff6b6b;" title="Xóa model">🗑</button>
              ` : `
                <button class="btn btn-primary btn-sm piper-dl-btn" data-model-id="${item.id}">⬇ Tải về (1-Click)</button>
              `}
            </div>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.piper-dl-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mid = btn.dataset.modelId;
        btn.disabled = true;
        btn.textContent = '⏳ Đang tải…';
        try {
          const dlRes = await fetch(`${BACKEND_URL}/piper/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_id: mid })
          });
          const dlData = await dlRes.json();
          if (!dlRes.ok) throw new Error(dlData.detail || 'Lỗi tải');
          showToast(dlData.message || 'Đã tải thành công!', 'ready');
          await loadPiperCatalog();
          await loadVoices();
        } catch (e) {
          showToast(`Lỗi tải: ${e.message}`, 'error');
          btn.disabled = false;
          btn.textContent = '⬇ Tải về (1-Click)';
        }
      });
    });

    container.querySelectorAll('.piper-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mid = btn.dataset.modelId;
        if (!confirm(`Bạn có chắc muốn xóa model ONNX này?`)) return;
        try {
          await fetch(`${BACKEND_URL}/piper/models/${mid}`, { method: 'DELETE' });
          showToast('Đã xóa model!', 'pending');
          await loadPiperCatalog();
          await loadVoices();
        } catch (e) {
          showToast(`Lỗi xóa: ${e.message}`, 'error');
        }
      });
    });

    container.querySelectorAll('.piper-use-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        useVoiceInStudio(btn.dataset.voiceId);
      });
    });

    container.querySelectorAll('.piper-preview-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const vid = btn.dataset.voiceId;
        btn.textContent = '…';
        try {
          const a = new Audio(`${BACKEND_URL}/voices/${encodeURIComponent(vid)}/preview`);
          await a.play();
        } catch (e) {
          showToast(`Lỗi nghe thử: ${e.message}`, 'error');
        } finally {
          btn.textContent = '▶ Thử';
        }
      });
    });

  } catch (err) {
    container.innerHTML = `<p class="empty-note" style="color:var(--text-muted);">Lỗi nạp danh mục: ${err.message}</p>`;
  }
}

// =====================================================
// Settings
// =====================================================

function setThreadStatus(message, kind) {
  const el = document.getElementById('thread-status');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'settings-status' + (kind ? ` ${kind}` : '');
}

function renderThreadOptions() {
  const container = document.getElementById('thread-options');
  if (!container) return;
  const options = [
    { value: 1, title: '1 luồng — Ổn định nhất', sub: 'Giọng lặp lại chính xác mỗi lần' },
    { value: 0, title: 'Tự động (mặc định SDK)', sub: `~${Math.min(Math.max(Math.floor(cpuLogicalCores / 2), 1), 8)} luồng — nhanh hơn, giọng có thể trôi nhẹ` },
  ];
  container.innerHTML = '';
  options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.className = 'thread-option-btn' + (currentThreads === opt.value ? ' active' : '');
    btn.innerHTML = `<span class="thread-option-title">${opt.title}</span><span class="thread-option-sub">${opt.sub}</span>`;
    btn.addEventListener('click', () => applyThreadSetting(opt.value));
    container.appendChild(btn);
  });
  const slider = document.getElementById('thread-custom-input');
  const sliderValue = document.getElementById('thread-custom-value');
  if (slider) {
    slider.max = String(Math.max(cpuLogicalCores, 1));
    if (currentThreads > 1) slider.value = String(currentThreads);
    if (sliderValue) sliderValue.textContent = slider.value;
    slider.oninput = () => { if (sliderValue) sliderValue.textContent = slider.value; };
    slider.onchange = () => applyThreadSetting(parseInt(slider.value, 10));
  }
}

async function applyThreadSetting(threads) {
  setThreadStatus('Đang áp dụng…', 'pending');
  try {
    const res = await fetch(`${BACKEND_URL}/settings/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threads }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || `HTTP ${res.status}`);
    }
    const data = await res.json();
    currentThreads = data.threads;
    renderThreadOptions();
    setThreadStatus(
      data.reload_pending
        ? 'Đã lưu — engine sẽ tải lại ở lần tạo tiếp theo.'
        : `Đã áp dụng — đang dùng ${data.threads} luồng.`,
      data.reload_pending ? 'pending' : 'ready'
    );
  } catch (err) {
    const msg = (err.name === 'TimeoutError' || err.message.includes('fetch') || err.message.includes('Failed'))
      ? 'Không kết nối được backend. Vui lòng đợi engine khởi động xong.'
      : `Lỗi: ${err.message}`;
    setThreadStatus(msg, 'error');
  }
}

// =====================================================
// Device setting (CPU / GPU)
// =====================================================

function setDeviceStatus(message, kind) {
  const el = document.getElementById('device-status');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'settings-status' + (kind ? ` ${kind}` : '');
}

function renderDeviceOptions(device) {
  currentDevice = device;
  document.querySelectorAll('.device-option-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.device === device);
  });
}

document.querySelectorAll('.device-option-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const dev = btn.dataset.device;
    if (dev === currentDevice) return;
    setDeviceStatus('Đang áp dụng…', 'pending');
    try {
      const res = await fetch(`${BACKEND_URL}/settings/device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: dev }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Lỗi');
      renderDeviceOptions(data.device);
      setDeviceStatus(
        data.reload_pending
          ? `Đã lưu (${data.device.toUpperCase()}) — engine sẽ tải lại ở lần tạo giọng tiếp theo.`
          : `Đang dùng: ${data.device.toUpperCase()}`,
        data.reload_pending ? 'pending' : ''
      );
    } catch (err) {
      setDeviceStatus(`Lỗi: ${err.message}`, 'error');
    }
  });
});

// =====================================================
// GPU Info
// =====================================================
async function loadGpuInfo() {
  const display = document.getElementById('gpu-info-display');
  if (!display) return;
  display.innerHTML = '<p class="settings-desc">Đang phát hiện GPU…</p>';
  try {
    const res = await fetch(`${BACKEND_URL}/system/gpu-info`);
    const data = await res.json();
    if (!data.gpus || data.gpus.length === 0) {
      display.innerHTML = '<p class="settings-desc" style="color:var(--text-muted);">Không tìm thấy GPU rời nào được nhận diện.</p>';
      return;
    }
    display.innerHTML = data.gpus.map(gpu => {
      const cudaOk = gpu.cuda_compatible;
      const icon = cudaOk ? '✅' : (gpu.type && gpu.type.includes('AMD') ? '🔴' : '🟡');
      const vram = gpu.vram_mb ? `${gpu.vram_mb} MB VRAM` : 'VRAM không rõ';
      const badgeClass = cudaOk ? 'cuda' : 'no-cuda';
      const badgeText = cudaOk ? 'CUDA ✓' : 'Không có CUDA';
      return `
        <div class="gpu-item ${cudaOk ? 'cuda-ok' : 'no-cuda'}">
          <span class="gpu-icon">${icon}</span>
          <div class="gpu-info">
            <div class="gpu-name">${escapeHtml(gpu.name)}</div>
            <div class="gpu-meta">${escapeHtml(gpu.type)} · ${vram}</div>
          </div>
          <span class="gpu-badge ${badgeClass}">${badgeText}</span>
        </div>
      `;
    }).join('');
    if (!data.cuda_available) {
      display.innerHTML += `<p class="settings-desc" style="margin-top:8px; color:var(--gold);">⚠️ Không có GPU CUDA. Hãy dùng chế độ <strong>CPU</strong> ở trên để tránh lỗi khi tạo giọng.</p>`;
    }
  } catch (err) {
    display.innerHTML = `<p class="settings-desc" style="color:var(--red);">Lỗi kiểm tra GPU: ${escapeHtml(err.message)}</p>`;
  }
}

const gpuRefreshBtn = document.getElementById('gpu-refresh-btn');
if (gpuRefreshBtn) gpuRefreshBtn.addEventListener('click', loadGpuInfo);

// =====================================================
// Speed Test Benchmark
// =====================================================
let currentBenchEngine = 'vieneu';
let currentBenchSample = 'standard';

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#bench-engine-row .filter-chip');
  if (btn) {
    document.querySelectorAll('#bench-engine-row .filter-chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    currentBenchEngine = btn.dataset.benchEngine || 'vieneu';
  }

  const sampleBtn = e.target.closest('#bench-sample-row .filter-chip');
  if (sampleBtn) {
    document.querySelectorAll('#bench-sample-row .filter-chip').forEach(c => c.classList.remove('active'));
    sampleBtn.classList.add('active');
    currentBenchSample = sampleBtn.dataset.benchSample || 'standard';
  }
});

const benchRunBtn = document.getElementById('bench-run-btn');
if (benchRunBtn) {
  benchRunBtn.addEventListener('click', async () => {
    const statusEl = document.getElementById('bench-status');
    const resultBox = document.getElementById('bench-result-box');
    const audioPlayer = document.getElementById('bench-audio-player');

    benchRunBtn.disabled = true;
    benchRunBtn.textContent = '⏳ Đang đo tốc độ…';
    if (statusEl) {
      statusEl.textContent = 'Đang tổng hợp giọng và đo lường thời gian thực tế…';
      statusEl.className = 'settings-status pending';
    }

    try {
      const res = await fetch(`${BACKEND_URL}/benchmark/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: currentBenchEngine,
          sample_type: currentBenchSample
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Lỗi không xác định khi đo tốc độ');

      if (resultBox) resultBox.style.display = 'block';

      const headline = document.getElementById('bench-headline');
      if (headline) headline.textContent = `⚡ Kết quả: ${data.engine_label}`;

      const badge = document.getElementById('bench-speed-badge');
      if (badge) {
        badge.textContent = `⚡ ${data.speed_factor}x Realtime`;
        badge.style.color = data.speed_factor >= 2.0 ? '#22c55e' : (data.speed_factor >= 1.0 ? '#fbbf24' : '#ef4444');
      }

      const statSpeed = document.getElementById('bench-stat-speed');
      if (statSpeed) statSpeed.textContent = `${data.speed_factor}x`;

      const statElapsed = document.getElementById('bench-stat-elapsed');
      if (statElapsed) statElapsed.textContent = `${data.elapsed_seconds}s`;

      const statDuration = document.getElementById('bench-stat-duration');
      if (statDuration) statDuration.textContent = `${data.audio_duration_seconds}s`;

      const statCps = document.getElementById('bench-stat-cps');
      if (statCps) statCps.textContent = `${data.chars_per_second}`;

      const statThreads = document.getElementById('bench-stat-threads');
      if (statThreads) statThreads.textContent = `Cấu hình: ${data.threads} luồng CPU (${data.device.toUpperCase()})`;

      if (audioPlayer && data.audio_url) {
        audioPlayer.src = `${BACKEND_URL}${data.audio_url}`;
      }

      if (statusEl) {
        statusEl.textContent = `Đo hoàn tất! Sinh ${data.char_count} ký tự (${data.audio_duration_seconds}s âm thanh) trong ${data.elapsed_seconds}s (Nhanh gấp ${data.speed_factor} lần thực tế).`;
        statusEl.className = 'settings-status';
      }
      showToast(`Đo tốc độ thành công: ${data.speed_factor}x Realtime!`, 'ready');
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Lỗi đo tốc độ: ${err.message}`;
        statusEl.className = 'settings-status error';
      }
      showToast(`Lỗi đo tốc độ: ${err.message}`, 'error');
    } finally {
      benchRunBtn.disabled = false;
      benchRunBtn.textContent = '🚀 Bắt đầu đo tốc độ';
    }
  });
}


// =====================================================
// Settings panel loader
// =====================================================
async function loadSettingsPanel() {
  setThreadStatus('Đang tải cài đặt…', 'pending');
  setDeviceStatus('Đang tải…', '');

  // If backend is not ready yet, wait up to 30s with retries
  const waitForBackend = async (maxWaitMs = 30000) => {
    const start = Date.now();
    while (!backendReady && Date.now() - start < maxWaitMs) {
      try {
        const probe = await fetch(`${BACKEND_URL}/voices`, { signal: AbortSignal.timeout(2000) });
        if (probe.ok) { backendReady = true; break; }
      } catch (_) { }
      await new Promise(r => setTimeout(r, 1000));
    }
    return backendReady;
  };

  const ready = await waitForBackend();
  if (!ready) {
    setThreadStatus('Backend chưa khởi động xong. Vui lòng đợi và thử lại.', 'error');
    setDeviceStatus('Chưa kết nối', 'error');
    return;
  }

  try {
    const [cpuRes, threadsRes, deviceRes] = await Promise.all([
      fetch(`${BACKEND_URL}/system/cpu-info`),
      fetch(`${BACKEND_URL}/settings/threads`),
      fetch(`${BACKEND_URL}/settings/device`),
    ]);

    if (!cpuRes.ok || !threadsRes.ok || !deviceRes.ok) {
      throw new Error(`HTTP ${cpuRes.status}/${threadsRes.status}/${deviceRes.status}`);
    }

    const cpu = await cpuRes.json();
    const threadsData = await threadsRes.json();
    const deviceData = await deviceRes.json();

    cpuLogicalCores = cpu.logical_cores || 8;
    currentThreads = threadsData.threads ?? 1;

    const logicalEl = document.getElementById('cpu-logical');
    const physicalEl = document.getElementById('cpu-physical');
    const platformEl = document.getElementById('cpu-platform');
    if (logicalEl) logicalEl.textContent = cpu.logical_cores ?? '–';
    if (physicalEl) physicalEl.textContent = cpu.physical_cores ?? '–';
    if (platformEl) platformEl.textContent = cpu.platform ?? '–';

    renderDeviceOptions(deviceData.device || 'cpu');
    setDeviceStatus(`Đang dùng: ${(deviceData.device || 'cpu').toUpperCase()}`);

    renderThreadOptions();
    setThreadStatus('');

    // Auto-load GPU info
    loadGpuInfo();
  } catch (err) {
    const msg = err.message.includes('fetch') || err.message.includes('Failed')
      ? 'Không kết nối được backend. Đảm bảo ứng dụng đã khởi động đầy đủ.'
      : `Lỗi tải cài đặt: ${err.message}`;
    setThreadStatus(msg, 'error');
    setDeviceStatus('Lỗi kết nối', 'error');
  }
}

// =====================================================
// Background Job Controller
// =====================================================
let activePollers = {};

function formatSeconds(sec) {
  if (sec == null || isNaN(sec) || sec < 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderProgressUI(container, jobId, statusData) {
  container.classList.remove('hidden');
  const progress = statusData.progress || 0;
  const currentStep = statusData.current_step || 0;
  const totalSteps = statusData.total_steps || 1;
  const eta = formatSeconds(statusData.eta_seconds);
  const elapsed = formatSeconds(statusData.elapsed_time);
  const isPaused = statusData.status === 'paused';
  const hasPartial = !!statusData.has_partial;
  const completedCount = statusData.completed_count || 0;

  // Use data-attributes + event delegation to avoid Electron CSP inline-onclick issues
  container.innerHTML = `
    <div class="progress-info">
      <span>Đang xử lý ${currentStep}/${totalSteps} (${progress.toFixed(1)}%)</span>
      <span>Chạy: ${elapsed} | Còn: ${eta}</span>
    </div>
    <div class="progress-bar-bg">
      <div class="progress-fill" style="width: ${progress}%;"></div>
    </div>
    <div class="job-actions">
      <button class="progress-pause-btn" data-job-id="${jobId}" data-action="pause">
        ${isPaused ? '▶ Tiếp tục' : '⏸ Tạm dừng'}
      </button>
      ${hasPartial ? `<button class="progress-partial-btn" data-job-id="${jobId}" data-action="partial">⬇ Tải phần đã tạo (${completedCount})</button>` : ''}
      <button class="progress-cancel-btn" data-job-id="${jobId}" data-action="cancel">✕ Hủy</button>
    </div>
  `;

  // Attach event listeners directly (no inline onclick)
  container.querySelectorAll('[data-job-id]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const jid = btn.dataset.jobId;
      const action = btn.dataset.action;
      if (action === 'pause') {
        try {
          const checkRes = await fetch(`${BACKEND_URL}/jobs/${jid}`);
          const jobData = await checkRes.json();
          const endpoint = jobData.status === 'paused' ? 'resume' : 'pause';
          await fetch(`${BACKEND_URL}/jobs/${jid}/${endpoint}`, { method: 'POST' });
        } catch (err) { showToast(`Lỗi: ${err.message}`, 'error'); }
      } else if (action === 'cancel') {
        if (!confirm('Bạn có chắc muốn hủy tác vụ này? Bạn vẫn có thể tải phần đã xử lý.')) return;
        try {
          await fetch(`${BACKEND_URL}/jobs/${jid}/cancel`, { method: 'POST' });
        } catch (err) { showToast(`Lỗi hủy: ${err.message}`, 'error'); }
      } else if (action === 'partial') {
        window.open(`${BACKEND_URL}/jobs/${jid}/download-partial`, '_blank');
      }
    });
  });
}

async function startBackgroundJob({
  endpoint, payload,
  progressBlockId, generateBtn, generateBtnText,
  resultPrefix, historyTitle, historySub,
  onComplete
}) {
  const container = document.getElementById(progressBlockId);
  if (generateBtn) {
    generateBtn.disabled = true;
    generateBtn.classList.add('working');
    generateBtn.textContent = '⏳ Đang xử lý…';
  }

  try {
    const startRes = await fetch(`${BACKEND_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const startData = await startRes.json();
    if (!startRes.ok) throw new Error(startData.detail || 'Lỗi khởi tạo tác vụ');

    const jobId = startData.job_id;
    if (activePollers[progressBlockId]) clearInterval(activePollers[progressBlockId]);

    activePollers[progressBlockId] = setInterval(async () => {
      try {
        const checkRes = await fetch(`${BACKEND_URL}/jobs/${jobId}`);
        if (!checkRes.ok) throw new Error('Không thể lấy tiến trình');
        const jobData = await checkRes.json();
        if (container) renderProgressUI(container, jobId, jobData);

        if (jobData.status === 'completed') {
          clearInterval(activePollers[progressBlockId]);
          delete activePollers[progressBlockId];
          if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.classList.remove('working');
            generateBtn.textContent = generateBtnText;
          }
          if (container) container.classList.add('hidden');
          if (jobData.file_path) applyAudioResult(resultPrefix, jobData.file_path);
          addHistoryItem(historyTitle, historySub);
          showToast('Đã tạo xong âm thanh!', 'ready');
          if (onComplete) onComplete(jobData);
        } else if (jobData.status === 'failed') {
          clearInterval(activePollers[progressBlockId]);
          delete activePollers[progressBlockId];
          if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.classList.remove('working');
            generateBtn.textContent = generateBtnText;
          }
          showToast(`Lỗi: ${jobData.error || 'Quá trình thất bại'}`, 'error');
        } else if (jobData.status === 'cancelled') {
          clearInterval(activePollers[progressBlockId]);
          delete activePollers[progressBlockId];
          if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.classList.remove('working');
            generateBtn.textContent = generateBtnText;
          }
          showToast('Đã hủy tác vụ.', 'pending');
        }
      } catch (err) {
        console.error('Job polling error:', err);
      }
    }, 800);

  } catch (err) {
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.classList.remove('working');
      generateBtn.textContent = generateBtnText;
    }
    if (container) container.classList.add('hidden');
    showToast(`Không thể bắt đầu: ${err.message}`, 'error');
  }
}

window.toggleJobPause = async function (jobId) {
  try {
    const checkRes = await fetch(`${BACKEND_URL}/jobs/${jobId}`);
    const jobData = await checkRes.json();
    const action = jobData.status === 'paused' ? 'resume' : 'pause';
    await fetch(`${BACKEND_URL}/jobs/${jobId}/${action}`, { method: 'POST' });
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
};

window.downloadJobPartial = function (jobId) {
  window.open(`${BACKEND_URL}/jobs/${jobId}/download-partial`, '_blank');
};

window.cancelBackgroundJob = async function (jobId) {
  if (!confirm('Bạn có chắc muốn hủy tác vụ này?')) return;
  try {
    await fetch(`${BACKEND_URL}/jobs/${jobId}/cancel`, { method: 'POST' });
  } catch (e) {
    showToast(`Lỗi hủy: ${e.message}`, 'error');
  }
};

// =====================================================
// Shared helpers
// =====================================================
function showToast(message, kind = '') {
  const container = document.getElementById('toast-container');
  if (!container) { console.warn(message); return; }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ` ${kind}` : '');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 220);
  }, 4000);
}

function getFilenameFromPath(filePath) {
  if (!filePath) return '';
  return filePath.replace(/\\/g, '/').split('/').pop();
}

function applyAudioResult(prefix, filePath) {
  const filename = getFilenameFromPath(filePath);
  const url = `${BACKEND_URL}/audio/${encodeURIComponent(filename)}`;
  const audioEl = document.getElementById(`${prefix}-audio`);
  const downloadEl = document.getElementById(`${prefix}-download`);
  if (audioEl) {
    audioEl.src = url;
    audioEl.classList.remove('hidden');
    audioEl.load();
    const playPromise = audioEl.play();
    if (playPromise !== undefined) {
      playPromise.catch(e => {
        console.log('Audio autoplay prevented:', e);
      });
    }
  }
  if (downloadEl) {
    downloadEl.href = url;
    downloadEl.download = `${prefix}_audio_${Date.now()}.wav`;
    downloadEl.style.display = 'inline-flex';
  }
}

function addHistoryItem(text, voiceInfo, audioUrl) {
  historyItems.unshift({
    text,
    voiceInfo,
    time: new Date().toLocaleTimeString('vi-VN'),
    audioUrl: audioUrl || null,
    filename: audioUrl ? ('vieneu_' + new Date().toISOString().replace(/[:.]/g, '-') + '.wav') : null,
  });
  _renderHistoryList();
}

function _renderHistoryList() {
  const list = document.getElementById('history-list');
  const listFull = document.getElementById('history-list-full');

  const html = historyItems.map((h, idx) => {
    const dlBtn = h.audioUrl
      ? `<a class="dl-btn" href="${escapeHtml(h.audioUrl)}" download="${escapeHtml(h.filename || 'vieneu_audio.wav')}" title="Tải về bản ghi này">⬇ Tải về</a>`
      : `<span class="dl-btn" style="opacity:0.3;cursor:not-allowed;" title="Không có file audio">⬇ Tải về</span>`;
    return `
    <div class="history-item">
      <span class="snippet" title="${escapeHtml(h.text)}">${escapeHtml(h.text)}</span>
      <span class="meta">${escapeHtml(h.voiceInfo || '')} · ${h.time}</span>
      ${dlBtn}
    </div>
  `;
  }).join('');

  if (list) list.innerHTML = html || '<p class="empty-note">Chưa có bản ghi nào. Tạo giọng nói để bắt đầu.</p>';
  if (listFull) listFull.innerHTML = html || '<p class="empty-note">Chưa có bản ghi nào.</p>';
}

// ---- Resize logic for recent panel ----
(function initRecentResize() {
  const STORAGE_KEY = 'vieneu_recent_height';

  function applyHeight(el, h) {
    el.style.height = h + 'px';
    localStorage.setItem(STORAGE_KEY, h);
  }

  function setup(handleId, sectionId) {
    const handle = document.getElementById(handleId);
    const section = document.getElementById(sectionId);
    if (!handle || !section) return;

    // Restore saved height
    const saved = parseInt(localStorage.getItem(STORAGE_KEY));
    if (saved && saved >= 80 && saved <= window.innerHeight * 0.6) {
      section.style.height = saved + 'px';
    }

    let startY = 0, startH = 0, dragging = false;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startH = section.offsetHeight;
      handle.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // Moving handle UP = increase height (section grows upward)
      const delta = startY - e.clientY;
      const minH = 80;
      const maxH = Math.floor(window.innerHeight * 0.6);
      const newH = Math.min(maxH, Math.max(minH, startH + delta));
      applyHeight(section, newH);
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setup('studio-recent-resize', 'studio-recent-section'));
  } else {
    setup('studio-recent-resize', 'studio-recent-section');
  }
})();



function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}



// =====================================================
// Initial render
// =====================================================
initConvoModule();
switchNav('studio');