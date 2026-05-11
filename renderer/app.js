const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  mode: 'video',
  quality: '1080p',
  bitrate: '192',
  folder: '',
  jobs: new Map(),
  history: [],
  uiMode: 'normal',
  vContainer: 'mp4',
  vCodec: 'auto',
  vBitrate: 0,
  aFormat: 'mp3',
};

const els = {
  pasteBtn: $('pasteBtn'),
  urlInput: $('urlInput'),
  modeVideo: $('modeVideo'),
  modeAudio: $('modeAudio'),
  startBtn: $('startBtn'),
  browseBtn: $('browseBtn'),
  openFolderBtn: $('openFolderBtn'),
  folderDisplay: $('folderDisplay'),
  activeGrid: $('activeGrid'),
  libraryList: $('libraryList'),
  log: $('log'),
  binWarning: $('binWarning'),
  themeToggle: $('themeToggle'),
};

(async function init() {
  state.folder = await window.api.defaultDownloadFolder();
  els.folderDisplay.textContent = state.folder;

  state.history = (await window.api.historyLoad()) || [];
  renderLibrary();

  const bin = await window.api.checkBinaries();
  if (!bin.ytdlpExists) {
    els.binWarning.classList.remove('hidden');
    els.binWarning.innerHTML = `
      <strong>yt-dlp not found.</strong> Place <code>yt-dlp.exe</code> in <code>${escapeHtml(bin.binDir)}</code>.
      Get it: <code>github.com/yt-dlp/yt-dlp/releases/latest</code>
    `;
  } else if (!bin.ffmpegExists) {
    els.binWarning.classList.remove('hidden');
    els.binWarning.innerHTML = `
      <strong>ffmpeg not found.</strong> Required for 1080p+ and MP3.
      Place <code>ffmpeg.exe</code> in <code>${escapeHtml(bin.binDir)}</code>.
    `;
  }

  bindEvents();
})();

function bindEvents() {
  // Tabs
  $$('.nav-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.nav-btn[data-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
      if (tab === 'library') renderLibrary();
    });
  });

  // Mode toggle
  els.modeVideo.addEventListener('change', () => switchMode('video'));
  els.modeAudio.addEventListener('change', () => switchMode('audio'));

  // Quality pills
  $$('.quality-group[data-group="video"] .pill').forEach((b) => {
    b.addEventListener('click', () => {
      $$('.quality-group[data-group="video"] .pill').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.quality = b.dataset.quality;
    });
  });
  $$('.quality-group[data-group="audio"] .pill').forEach((b) => {
    b.addEventListener('click', () => {
      $$('.quality-group[data-group="audio"] .pill').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.bitrate = b.dataset.bitrate;
    });
  });

  // Buttons
  els.pasteBtn.addEventListener('click', async () => {
    const txt = await window.api.readClipboard();
    if (txt) els.urlInput.value = txt.trim();
    els.urlInput.focus();
  });

  els.browseBtn.addEventListener('click', async () => {
    const f = await window.api.pickFolder();
    if (f) {
      state.folder = f;
      els.folderDisplay.textContent = f;
    }
  });

  els.openFolderBtn.addEventListener('click', () => {
    if (state.folder) window.api.openFolder(state.folder);
  });

  els.startBtn.addEventListener('click', startDownload);

  els.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startDownload();
  });

  // Normal/Advanced toggle
  $$('.mode-switch .seg-btn').forEach((b) => {
    b.addEventListener('click', () => setUiMode(b.dataset.uiMode));
  });
  setUiMode(localStorage.getItem('uiMode') === 'advanced' ? 'advanced' : 'normal');

  // Advanced controls
  const vContainer = $('vContainer');
  const vCodec = $('vCodec');
  const vBitrate = $('vBitrate');
  const vBitrateLabel = $('vBitrateLabel');
  const aFormat = $('aFormat');
  const aBitrate = $('aBitrate');
  const aBitrateLabel = $('aBitrateLabel');
  vContainer.addEventListener('change', () => (state.vContainer = vContainer.value));
  vCodec.addEventListener('change', () => (state.vCodec = vCodec.value));
  vBitrate.addEventListener('input', () => {
    state.vBitrate = Number(vBitrate.value);
    vBitrateLabel.textContent = state.vBitrate > 0 ? `${state.vBitrate} kbps` : 'auto';
  });
  aFormat.addEventListener('change', () => (state.aFormat = aFormat.value));
  aBitrate.addEventListener('input', () => {
    state.bitrate = String(aBitrate.value);
    aBitrateLabel.textContent = `${aBitrate.value} kbps`;
    // sync the pill row so Normal mode reflects custom value if it matches
    $$('.quality-group[data-group="audio"] .pill').forEach((p) =>
      p.classList.toggle('active', p.dataset.bitrate === state.bitrate)
    );
  });

  // Theme
  els.themeToggle.addEventListener('change', () => {
    document.body.classList.toggle('light', !els.themeToggle.checked);
    localStorage.setItem('theme', els.themeToggle.checked ? 'dark' : 'light');
  });
  if (localStorage.getItem('theme') === 'light') {
    els.themeToggle.checked = false;
    document.body.classList.add('light');
  }

  // IPC
  window.api.onProgress(handleProgress);
  window.api.onLog(handleLog);
  window.api.onDone(handleDone);
  window.api.onBridgeDownload(handleBridgeDownload);
}

function handleBridgeDownload(data) {
  document.querySelector('.nav-btn[data-tab="new"]').click();
  els.urlInput.value = data.url || '';
  switchMode(data.mode === 'audio' ? 'audio' : 'video');
  if (data.mode === 'audio' && data.audioBitrate) {
    state.bitrate = String(data.audioBitrate);
    document.querySelectorAll('.quality-group[data-group="audio"] .pill').forEach((b) =>
      b.classList.toggle('active', b.dataset.bitrate === state.bitrate)
    );
  } else if (data.quality) {
    state.quality = data.quality;
    document.querySelectorAll('.quality-group[data-group="video"] .pill').forEach((b) =>
      b.classList.toggle('active', b.dataset.quality === state.quality)
    );
  }
  startDownload();
}

function setUiMode(mode) {
  state.uiMode = mode === 'advanced' ? 'advanced' : 'normal';
  document.body.classList.toggle('advanced', state.uiMode === 'advanced');
  $$('.mode-switch .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.uiMode === state.uiMode)
  );
  localStorage.setItem('uiMode', state.uiMode);
}

function switchMode(mode) {
  state.mode = mode;
  if (mode === 'video') {
    els.modeVideo.checked = true;
    els.modeAudio.checked = false;
  } else {
    els.modeVideo.checked = false;
    els.modeAudio.checked = true;
  }
  document.querySelector('.quality-group[data-group="video"]').classList.toggle('hidden', mode !== 'video');
  document.querySelector('.quality-group[data-group="audio"]').classList.toggle('hidden', mode !== 'audio');
}

async function startDownload() {
  const url = els.urlInput.value.trim();
  if (!url) {
    els.urlInput.focus();
    return;
  }
  if (!state.folder) {
    alert('Pick a save folder first.');
    return;
  }

  const id = 'job_' + Math.random().toString(36).slice(2, 9);
  const advanced = state.uiMode === 'advanced';
  const job = {
    id,
    url,
    folder: state.folder,
    mode: state.mode,
    quality: state.quality,
    audioBitrate: state.bitrate,
    isPlaylist: false,
    title: url,
    thumbnail: '',
    percent: 0,
    state: 'starting',
    vContainer: advanced ? state.vContainer : 'mp4',
    vCodec: advanced ? state.vCodec : 'auto',
    vBitrate: advanced ? state.vBitrate : 0,
    aFormat: advanced ? state.aFormat : 'mp3',
  };
  state.jobs.set(id, job);
  renderJob(job);
  els.urlInput.value = '';

  // Fetch metadata in background (don't block)
  window.api.fetchInfo(url).then((info) => {
    if (info.ok) {
      job.title = info.title || job.url;
      job.thumbnail = info.thumbnail || '';
      updateJobCard(job);
    }
  });

  await window.api.startDownload(job);
}

function renderJob(job) {
  const div = document.createElement('div');
  div.className = 'job';
  div.id = job.id;
  div.innerHTML = `
    <div class="job-body">
      <div class="job-thumb">
        ${job.thumbnail
          ? `<img src="${escapeAttr(job.thumbnail)}" referrerpolicy="no-referrer" onerror="this.style.display='none'"/>`
          : `<span class="placeholder-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16v12H4z" stroke="currentColor" stroke-width="1.6"/><path d="M10 9l5 3-5 3V9z" fill="currentColor"/></svg></span>`}
        <span class="badge">${job.mode === 'audio' ? 'MP3' : (job.quality || 'best').toUpperCase()}</span>
      </div>
      <div class="job-info">
        <div class="job-header">
          <span class="job-title">${escapeHtml(job.title)}</span>
          <span class="job-state">Starting…</span>
        </div>
        <div class="bar"><div class="bar-fill"></div></div>
        <div class="job-meta">
          <span class="size">—</span>
          <span class="speed">—</span>
        </div>
      </div>
    </div>
    <div class="job-controls">
      <span class="controls-label">Controls</span>
      <button class="ctrl-btn pause-btn">
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
        <span class="pause-label">Pause</span>
      </button>
      <button class="ctrl-btn danger cancel-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
        Cancel
      </button>
      <button class="ctrl-btn open-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
        Open Folder
      </button>
    </div>
  `;
  els.activeGrid.prepend(div);

  div.querySelector('.pause-btn').addEventListener('click', () => togglePause(job.id));
  div.querySelector('.cancel-btn').addEventListener('click', () => cancelJob(job.id));
  div.querySelector('.open-btn').addEventListener('click', () => window.api.openFolder(job.folder));
}

function updateJobCard(job) {
  const card = document.getElementById(job.id);
  if (!card) return;
  card.querySelector('.job-title').textContent = job.title;
  if (job.thumbnail) {
    const thumb = card.querySelector('.job-thumb');
    thumb.innerHTML = `<img src="${escapeAttr(job.thumbnail)}" referrerpolicy="no-referrer" onerror="this.style.display='none'"/><span class="badge">${job.mode === 'audio' ? 'MP3' : (job.quality || 'best').toUpperCase()}</span>`;
  }
}

function handleProgress({ id, percent, size, speed, eta }) {
  const job = state.jobs.get(id);
  if (!job) return;
  job.percent = percent;
  job.state = 'downloading';
  const card = document.getElementById(id);
  if (!card) return;
  card.querySelector('.bar-fill').style.width = `${percent}%`;
  card.querySelector('.job-state').textContent = `${percent.toFixed(0)}%`;
  card.querySelector('.job-state').className = 'job-state';
  card.querySelector('.size').textContent = size ? `${formatProgress(percent, size)}` : '—';
  card.querySelector('.speed').textContent = speed ? `${speed}${eta ? ' · ETA ' + eta : ''}` : '—';
  setPauseLabel(card, 'Pause');
}

function formatProgress(percent, totalSize) {
  if (!totalSize) return '';
  const downloaded = ((percent / 100) * parseSize(totalSize));
  return `${humanSize(downloaded)} / ${totalSize}`;
}
function parseSize(s) {
  const m = String(s).match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  const mult = { B: 1, KB: 1024, KIB: 1024, MB: 1048576, MIB: 1048576, GB: 1073741824, GIB: 1073741824, TB: 1099511627776, TIB: 1099511627776 }[u] || 1;
  return v * mult;
}
function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(bytes >= 100 ? 0 : 1)} ${units[i]}`;
}

function handleLog({ id, message, error }) {
  if (!message) return;
  const stamp = new Date().toLocaleTimeString();
  els.log.textContent += `[${stamp}] ${message}\n`;
  els.log.scrollTop = els.log.scrollHeight;

  const job = id && state.jobs.get(id);
  if (job && message.startsWith('→')) {
    job.title = message.slice(2).trim();
    const card = document.getElementById(id);
    if (card) card.querySelector('.job-title').textContent = job.title;
  }
}

function handleDone({ id, ok, error, code, file, percent }) {
  const job = state.jobs.get(id);
  if (!job) return;
  const card = document.getElementById(id);
  if (!card) return;
  if (ok) {
    job.state = 'done';
    job.file = file || '';
    card.classList.add('done');
    card.querySelector('.bar-fill').style.width = '100%';
    const st = card.querySelector('.job-state');
    st.textContent = 'Done';
    st.className = 'job-state done';
    card.querySelector('.speed').textContent = '';

    state.history.unshift({
      id, url: job.url, title: job.title, thumbnail: job.thumbnail,
      mode: job.mode, quality: job.quality, file: job.file,
      folder: job.folder, completedAt: Date.now(),
    });
    if (state.history.length > 200) state.history.length = 200;
    window.api.historySave(state.history);

    setTimeout(() => {
      if (card && card.parentElement) card.parentElement.removeChild(card);
      state.jobs.delete(id);
      renderLibrary();
    }, 4000);
  } else {
    job.state = 'error';
    card.classList.add('error');
    const st = card.querySelector('.job-state');
    st.textContent = error ? 'Failed' : `Failed (${code})`;
    st.className = 'job-state error';
  }
}

async function togglePause(id) {
  const job = state.jobs.get(id);
  if (!job) return;
  const card = document.getElementById(id);
  if (job.state === 'paused') {
    setPauseLabel(card, 'Pause');
    const st = card.querySelector('.job-state');
    st.textContent = 'Resuming…';
    st.className = 'job-state';
    job.state = 'downloading';
    await window.api.resumeDownload(id);
  } else {
    await window.api.pauseDownload(id);
    job.state = 'paused';
    setPauseLabel(card, 'Resume');
    const st = card.querySelector('.job-state');
    st.textContent = 'Paused';
    st.className = 'job-state paused';
  }
}

function setPauseLabel(card, label) {
  if (!card) return;
  const lbl = card.querySelector('.pause-label');
  if (lbl) lbl.textContent = label;
  const btn = card.querySelector('.pause-btn svg');
  if (!btn) return;
  if (label === 'Resume') {
    btn.innerHTML = `<polygon points="6,4 20,12 6,20" fill="currentColor"/>`;
  } else {
    btn.innerHTML = `<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>`;
  }
}

async function cancelJob(id) {
  await window.api.cancelDownload(id);
  const card = document.getElementById(id);
  if (card && card.parentElement) card.parentElement.removeChild(card);
  state.jobs.delete(id);
}

function renderLibrary() {
  els.libraryList.innerHTML = '';
  for (const item of state.history) {
    const div = document.createElement('div');
    div.className = 'lib-item';
    div.innerHTML = `
      <div class="lib-thumb">${item.thumbnail ? `<img src="${escapeAttr(item.thumbnail)}" referrerpolicy="no-referrer" onerror="this.style.display='none'"/>` : ''}</div>
      <div class="lib-info">
        <div class="lib-title">${escapeHtml(item.title || item.url)}</div>
        <div class="lib-sub">${item.mode === 'audio' ? 'MP3 ' + (item.audioBitrate || '') : (item.quality || '')} · ${new Date(item.completedAt).toLocaleString()}</div>
      </div>
      <div class="lib-actions">
        <button class="ghost-btn open-file">Open</button>
        <button class="ghost-btn open-loc">Folder</button>
      </div>
    `;
    div.querySelector('.open-file').addEventListener('click', () => {
      if (item.file) window.api.openFolder(item.file);
    });
    div.querySelector('.open-loc').addEventListener('click', () => {
      if (item.folder) window.api.openFolder(item.folder);
    });
    els.libraryList.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }
