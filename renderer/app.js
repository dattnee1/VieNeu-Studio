let BACKEND_URL = 'http://127.0.0.1:8722';
let voices = []; // [{label, id}]
let historyItems = [];
let convoLineCount = 0;

// ---------- Backend status ----------
window.vieneu.onBackendStatus(async (payload) => {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  BACKEND_URL = payload.url || BACKEND_URL;

  dot.classList.remove('ready', 'error');

  if (payload.ready) {
    dot.classList.add('ready');
    text.textContent = 'Engine sẵn sàng';
    await loadVoices();
  } else if (payload.error) {
    dot.classList.add('error');
    text.textContent = 'Lỗi khởi động engine';
    showBackendError(payload.message);
  } else if (payload.loading) {
    text.textContent = payload.message || 'Đang tải mô hình…';
  } else {
    dot.classList.add('error');
    text.textContent = 'Engine chưa khởi động';
  }
});

function showBackendError(message) {
  const banner = document.getElementById('error-banner');
  if (!banner) return;
  banner.textContent = `Không thể tải mô hình: ${message}`;
  banner.style.display = 'block';
}

// Fallback in case the app loaded before the event fired
window.vieneu.getBackendUrl().then((url) => { BACKEND_URL = url; });

// ---------- Settings: CPU detection + thread count ----------
let cpuLogicalCores = 8;
let currentThreads = 1;

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
    { value: 1, title: '1 luồng — Ổn định nhất', sub: 'Giọng lặp lại chính xác mỗi lần, tốc độ chậm nhất' },
    { value: 0, title: 'Tự động (mặc định SDK)', sub: `~${Math.min(Math.max(Math.floor(cpuLogicalCores / 2), 1), 8)} luồng — nhanh nhất, giọng có thể trôi nhẹ` },
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
    // Reflect current value only when it's a manual (non-0/1) setting, so the
    // slider doesn't silently drift out of sync with the active preset button.
    if (currentThreads > 1) {
      slider.value = String(currentThreads);
    }
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
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Unknown error');
    currentThreads = data.threads;
    renderThreadOptions();
    setThreadStatus(
      data.reload_pending
        ? 'Đã lưu — engine sẽ tải lại ở lần tạo giọng nói tiếp theo (có thể mất vài giây).'
        : 'Đã áp dụng.',
      data.reload_pending ? 'pending' : ''
    );
  } catch (err) {
    setThreadStatus(`Lỗi: ${err.message}`, 'error');
  }
}

async function loadSettingsPanel() {
  try {
    const [cpuRes, threadsRes] = await Promise.all([
      fetch(`${BACKEND_URL}/system/cpu-info`),
      fetch(`${BACKEND_URL}/settings/threads`),
    ]);
    const cpu = await cpuRes.json();
    const threadsData = await threadsRes.json();
    cpuLogicalCores = cpu.logical_cores || 8;
    currentThreads = threadsData.threads ?? 1;

    const logicalEl = document.getElementById('cpu-logical');
    const physicalEl = document.getElementById('cpu-physical');
    if (logicalEl) logicalEl.textContent = cpu.logical_cores ?? '–';
    if (physicalEl) physicalEl.textContent = cpu.physical_cores ?? '–';

    renderThreadOptions();
    setThreadStatus('');
  } catch (err) {
    setThreadStatus(`Không thể tải cài đặt: ${err.message}`, 'error');
  }
}

let settingsLoaded = false;

// ---------- Tabs ----------
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'settings' && !settingsLoaded) {
      settingsLoaded = true;
      loadSettingsPanel();
    }
  });
});

// ---------- Voices ----------
async function loadVoices() {
  try {
    const res = await fetch(`${BACKEND_URL}/voices`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Unknown error');
    voices = data;
  } catch (e) {
    console.error('Failed to load voices', e);
    voices = [];
    showBackendError('Không tải được danh sách giọng đọc. Kiểm tra terminal để xem log backend.');
  }
  const studioSelect = document.getElementById('studio-voice');
  studioSelect.innerHTML = voices.map(v => `<option value="${v.id}">${v.label}</option>`).join('');
  const narratorSelect = document.getElementById('story-narrator-voice');
  if (narratorSelect) {
    narratorSelect.innerHTML = voices.map(v => `<option value="${v.id}">${v.label}</option>`).join('');
  }
  renderConvoSpeakerVoices();
  renderLibrary();
}

// ---------- Voice library ----------
const GENDER_LABEL = { nam: 'Nam', nu: 'Nữ', chua_ro: 'Chưa rõ giới tính' };
const REGION_LABEL = { bac: 'Bắc', trung: 'Trung', nam: 'Nam', chua_ro: 'Chưa rõ vùng miền' };

let libFilters = { gender: 'all', region: 'all' };
let libSearch = '';

document.getElementById('lib-search').addEventListener('input', (e) => {
  libSearch = e.target.value.trim().toLowerCase();
  renderLibrary();
});

document.querySelectorAll('.filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const group = chip.dataset.filter;
    document.querySelectorAll(`.filter-chip[data-filter="${group}"]`).forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    libFilters[group] = chip.dataset.value;
    renderLibrary();
  });
});

function renderLibrary() {
  const list = document.getElementById('lib-list');
  const countEl = document.getElementById('lib-count');
  if (!list) return;

  const filtered = voices.filter((v) => {
    if (libSearch && !v.label.toLowerCase().includes(libSearch)) return false;
    if (libFilters.gender !== 'all' && v.gender !== libFilters.gender) return false;
    if (libFilters.region !== 'all' && v.region !== libFilters.region) return false;
    return true;
  });

  countEl.textContent = `${filtered.length} / ${voices.length} giọng`;

  if (filtered.length === 0) {
    list.innerHTML = '<p class="empty-note-lib">Không tìm thấy giọng phù hợp bộ lọc.</p>';
    return;
  }

  list.innerHTML = filtered.map((v) => `
    <div class="lib-item" data-voice-id="${v.id}">
      <button class="lib-play" data-voice-id="${v.id}">▶</button>
      <div class="lib-info">
        <span class="lib-name">${escapeHtml(v.label)}</span>
        <span class="lib-tags">
          <span class="lib-tag">${GENDER_LABEL[v.gender] || v.gender}</span>
          <span class="lib-tag">${REGION_LABEL[v.region] || v.region}</span>
        </span>
      </div>
      <audio class="lib-audio" style="display:none;"></audio>
      <button class="lib-use-btn" data-voice-id="${v.id}">Dùng giọng này</button>
    </div>
  `).join('');

  list.querySelectorAll('.lib-play').forEach((btn) => {
    btn.addEventListener('click', () => playPreview(btn));
  });
  list.querySelectorAll('.lib-use-btn').forEach((btn) => {
    btn.addEventListener('click', () => useVoiceInStudio(btn.dataset.voiceId));
  });
}

async function playPreview(btn) {
  const voiceId = btn.dataset.voiceId;
  const item = btn.closest('.lib-item');
  const audioEl = item.querySelector('.lib-audio');
  btn.classList.add('loading');
  btn.textContent = '…';
  try {
    audioEl.src = `${BACKEND_URL}/voices/${encodeURIComponent(voiceId)}/preview`;
    await audioEl.play();
  } catch (e) {
    showToast('Không phát được bản nghe thử: ' + e.message, 'error');
  } finally {
    btn.classList.remove('loading');
    btn.textContent = '▶';
  }
}

function useVoiceInStudio(voiceId) {
  document.getElementById('studio-voice').value = voiceId;
  document.querySelector('.nav-item[data-tab="studio"]').click();
}

// ---------- Emotion cue chips ----------
document.querySelectorAll('.cue-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const ta = document.getElementById('studio-text');
    const cue = chip.dataset.cue;
    const pos = ta.selectionEnd || ta.value.length;
    ta.value = ta.value.slice(0, pos) + ' ' + cue + ' ' + ta.value.slice(pos);
    ta.focus();
  });
});

// ---------- Studio tab ----------
let lastStudioSeed = null;

// Keep the Generate button disabled while the text box is empty, matching
// the reference app's behavior — this also means an accidental click can't
// even reach the empty-text guard below.
function updateStudioGenerateAvailability() {
  const text = document.getElementById('studio-text').value.trim();
  document.getElementById('studio-generate').disabled = !text;
}
document.getElementById('studio-text').addEventListener('input', updateStudioGenerateAvailability);
updateStudioGenerateAvailability();

document.getElementById('studio-generate').addEventListener('click', async () => {
  const btn = document.getElementById('studio-generate');
  const label = document.getElementById('studio-generate-label');
  const text = document.getElementById('studio-text').value.trim();
  const voice = document.getElementById('studio-voice').value;
  const seedInput = document.getElementById('studio-seed').value.trim();
  // Default to seed 1 (not random) so repeated generations of the same voice
  // sound the same unless you deliberately change or randomize the seed.
  const seed = seedInput ? parseInt(seedInput, 10) : 1;
  if (!text) {
    showToast('Hãy nhập nội dung văn bản trước khi tạo giọng nói.');
    document.getElementById('studio-text').focus();
    return;
  }

  setSealWorking(btn, label, 'Đang tạo…');
  try {
    const res = await fetch(`${BACKEND_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, seed }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Lỗi không xác định');
    applyAudioResult('studio', data.file_path);
    lastStudioSeed = data.seed;
    document.getElementById('studio-seed').value = data.seed;
    addHistoryItem(text, `${voice} · seed ${data.seed}`);
  } catch (e) {
    showToast('Không thể tạo giọng nói: ' + e.message, 'error');
  } finally {
    resetSeal(btn, label, 'Tạo giọng nói');
    updateStudioGenerateAvailability();
  }
});

document.getElementById('studio-seed-random').addEventListener('click', () => {
  document.getElementById('studio-seed').value = Math.floor(Math.random() * 1e9);
});

// ---------- Clone tab ----------
let cloneFileB64 = null;
document.getElementById('clone-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  document.getElementById('clone-file-name').textContent = file ? file.name : 'Chưa chọn file';
  if (!file) { cloneFileB64 = null; return; }
  const buf = await file.arrayBuffer();
  cloneFileB64 = arrayBufferToBase64(buf);
});

document.getElementById('clone-generate').addEventListener('click', async () => {
  const btn = document.getElementById('clone-generate');
  const label = document.getElementById('clone-generate-label');
  const text = document.getElementById('clone-text').value.trim();
  const refText = document.getElementById('clone-ref-text').value.trim();
  if (!text) return;
  if (!cloneFileB64) { showToast('Vui lòng chọn file âm thanh mẫu trước.'); return; }

  setSealWorking(btn, label, 'Đang nhân bản…');
  try {
    const res = await fetch(`${BACKEND_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ref_audio_b64: cloneFileB64, ref_text: refText || null }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Lỗi không xác định');
    applyAudioResult('clone', data.file_path);
    addHistoryItem(text, 'Giọng nhân bản');
  } catch (e) {
    showToast('Không thể nhân bản giọng: ' + e.message, 'error');
  } finally {
    resetSeal(btn, label, 'Nhân bản & đọc');
  }
});

// ---------- Conversation tab ----------
function addConvoLine(speaker = '', text = '') {
  convoLineCount += 1;
  const id = `line-${convoLineCount}`;
  const wrap = document.createElement('div');
  wrap.className = 'convo-line';
  wrap.id = id;
  wrap.innerHTML = `
    <input type="text" class="line-speaker" placeholder="Nhân vật" value="${speaker}" />
    <textarea class="line-text" placeholder="Lời thoại…">${text}</textarea>
    <button class="remove-line">Xoá</button>
  `;
  wrap.querySelector('.remove-line').addEventListener('click', () => {
    wrap.remove();
    renderConvoSpeakerVoices();
  });
  wrap.querySelector('.line-speaker').addEventListener('change', renderConvoSpeakerVoices);
  document.getElementById('convo-lines').appendChild(wrap);
  renderConvoSpeakerVoices();
}

document.getElementById('convo-add-line').addEventListener('click', () => addConvoLine());

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
  const speakers = getConvoSpeakers();
  if (speakers.length === 0) {
    container.innerHTML = '<p class="empty-note">Thêm lời thoại và đặt tên nhân vật để gán giọng.</p>';
    return;
  }
  const options = voices.map(v => `<option value="${v.id}">${v.label}</option>`).join('');
  container.innerHTML = speakers.map((s) => `
    <div class="speaker-voice-row">
      <label>${s}</label>
      <select class="select speaker-voice-select" data-speaker="${s}">${options}</select>
    </div>
  `).join('');
}

document.getElementById('convo-generate').addEventListener('click', async () => {
  const btn = document.getElementById('convo-generate');
  const label = document.getElementById('convo-generate-label');

  const lines = Array.from(document.querySelectorAll('.convo-line')).map((el) => ({
    speaker: el.querySelector('.line-speaker').value.trim(),
    text: el.querySelector('.line-text').value.trim(),
  })).filter(l => l.speaker && l.text);

  if (lines.length === 0) { showToast('Hãy thêm ít nhất một lời thoại có tên nhân vật.'); return; }

  const speakerVoices = {};
  document.querySelectorAll('.speaker-voice-select').forEach((sel) => {
    speakerVoices[sel.dataset.speaker] = sel.value;
  });

  setSealWorking(btn, label, 'Đang xử lý…');
  try {
    const res = await fetch(`${BACKEND_URL}/conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines, speaker_voices: speakerVoices }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Lỗi không xác định');
    applyAudioResult('convo', data.file_path);
    addHistoryItem(`Hội thoại (${lines.length} lời thoại)`, Object.values(speakerVoices).join(', '));
  } catch (e) {
    showToast('Không thể tạo hội thoại: ' + e.message, 'error');
  } finally {
    resetSeal(btn, label, 'Tạo hội thoại');
  }
});

// seed with two starter lines
addConvoLine('Nhân vật A', '');
addConvoLine('Nhân vật B', '');

// ---------- Story (Truyện) tab ----------
let storyCharacters = []; // character names found by the last /story/parse call

function setStoryParseStatus(message, kind) {
  const el = document.getElementById('story-parse-status');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'settings-status' + (kind ? ` ${kind}` : '');
}

function renderStoryCharacterVoices() {
  const container = document.getElementById('story-character-voices');
  const labelEl = document.getElementById('story-characters-label');
  if (!container) return;
  if (storyCharacters.length === 0) {
    container.innerHTML = '';
    if (labelEl) labelEl.style.display = 'none';
    return;
  }
  if (labelEl) labelEl.style.display = '';
  const options = voices.map(v => `<option value="${v.id}">${v.label}</option>`).join('');
  container.innerHTML = storyCharacters.map((name) => `
    <div class="speaker-voice-row">
      <label>${escapeHtml(name)}</label>
      <select class="select story-character-voice-select" data-character="${escapeHtml(name)}">${options}</select>
    </div>
  `).join('');
}

document.getElementById('story-parse').addEventListener('click', async () => {
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
    setStoryParseStatus(
      `Tìm thấy ${data.segments.length} đoạn (${storyCharacters.length} nhân vật). Gán giọng rồi tạo audiobook.`
    );
    document.getElementById('story-generate').disabled = false;
  } catch (e) {
    setStoryParseStatus(`Lỗi: ${e.message}`, 'error');
    storyCharacters = [];
    renderStoryCharacterVoices();
  }
});

document.getElementById('story-generate').addEventListener('click', async () => {
  const btn = document.getElementById('story-generate');
  const label = document.getElementById('story-generate-label');
  const text = document.getElementById('story-text').value.trim();
  const narratorVoice = document.getElementById('story-narrator-voice').value;

  if (!text) { showToast('Hãy dán nội dung truyện trước.'); return; }
  if (!narratorVoice) { showToast('Hãy chọn giọng người kể chuyện.'); return; }

  const characterVoices = {};
  document.querySelectorAll('.story-character-voice-select').forEach((sel) => {
    characterVoices[sel.dataset.character] = sel.value;
  });

  setSealWorking(btn, label, 'Đang tạo audiobook…');
  try {
    const res = await fetch(`${BACKEND_URL}/story/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        narrator_voice: narratorVoice,
        character_voices: characterVoices,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Lỗi không xác định');
    applyAudioResult('story', data.file_path);
    addHistoryItem(
      `Truyện (${data.segment_count} đoạn, ${storyCharacters.length} nhân vật)`,
      `Người kể: ${narratorVoice}`
    );
  } catch (e) {
    showToast('Không thể tạo audiobook: ' + e.message, 'error');
  } finally {
    resetSeal(btn, label, 'Tạo audiobook');
  }
});

// ---------- Shared helpers ----------
// showToast replaces window.alert() everywhere in this file. alert() is a
// blocking native dialog in Electron — if it ever renders off-screen or
// without focus (seen on some Windows/multi-monitor setups), the entire
// window becomes unresponsive to clicks (including the text box) until a
// dialog the user can't see is dismissed. Toasts are inline, non-blocking,
// and always leave the rest of the UI interactive.
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

function setSealWorking(btn, label, text) {
  btn.disabled = true;
  btn.classList.add('working');
  label.textContent = text;
}
function resetSeal(btn, label, text) {
  btn.disabled = false;
  btn.classList.remove('working');
  label.textContent = text;
}

function applyAudioResult(prefix, filePath) {
  const filename = filePath.split(/[\\/]/).pop();
  const url = `${BACKEND_URL}/audio/${filename}`;
  const audioEl = document.getElementById(`${prefix}-audio`);
  const downloadEl = document.getElementById(`${prefix}-download`);
  audioEl.src = url;
  audioEl.play().catch(() => {});
  downloadEl.href = url;
  downloadEl.style.display = 'block';
}

function addHistoryItem(text, voiceInfo) {
  historyItems.unshift({ text, voiceInfo, time: new Date().toLocaleTimeString('vi-VN') });
  const list = document.getElementById('history-list');
  list.innerHTML = historyItems.map(h => `
    <div class="history-item">
      <span class="snippet">${escapeHtml(h.text)}</span>
      <span class="meta">${escapeHtml(h.voiceInfo || '')} · ${h.time}</span>
    </div>
  `).join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
