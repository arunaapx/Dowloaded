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
  libSearch: $('libSearch'),
  libClear: $('libClear'),
  sitesGrid: $('sitesGrid'),
  bv: $('bv'),
  bvBack: $('bvBack'),
  bvFwd: $('bvFwd'),
  bvReload: $('bvReload'),
  bvUrl: $('bvUrl'),
  bvDownload: $('bvDownload'),
  bvLoading: $('bvLoading'),
  searchInput: $('searchInput'),
  searchBtn: $('searchBtn'),
  searchStatus: $('searchStatus'),
  searchResults: $('searchResults'),
  log: $('log'),
  binWarning: $('binWarning'),
  themeToggle: $('themeToggle'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  statActive: $('statActive'),
  statSpeed: $('statSpeed'),
  settingsBrowseBtn: $('settingsBrowseBtn'),
  settingsFolderHint: $('settingsFolderHint'),
  settingsYtdlp: $('settingsYtdlp'),
  settingsFfmpeg: $('settingsFfmpeg'),
};

const SUPPORTED_SITES = [
  { name: 'YouTube',     url: 'https://www.youtube.com',    color: '#ff0033', mark: 'Y' },
  { name: 'Facebook',    url: 'https://www.facebook.com',   color: '#1877f2', mark: 'F' },
  { name: 'Instagram',   url: 'https://www.instagram.com',  color: '#e1306c', mark: 'I' },
  { name: 'TikTok',      url: 'https://www.tiktok.com',     color: '#000000', mark: 'T' },
  { name: 'X (Twitter)', url: 'https://x.com',              color: '#1d1f23', mark: 'X' },
  { name: 'Vimeo',       url: 'https://vimeo.com',          color: '#1ab7ea', mark: 'V' },
  { name: 'Dailymotion', url: 'https://www.dailymotion.com',color: '#0d244c', mark: 'D' },
  { name: 'Twitch',      url: 'https://www.twitch.tv',      color: '#9146ff', mark: 'T' },
  { name: 'SoundCloud',  url: 'https://soundcloud.com',     color: '#ff5500', mark: 'S' },
  { name: 'Reddit',      url: 'https://www.reddit.com',     color: '#ff4500', mark: 'R' },
];

(async function init() {
  // License gate first — block the app until activated
  await runLicenseGate();

  state.folder = await window.api.defaultDownloadFolder();
  els.folderDisplay.textContent = state.folder;

  state.history = (await window.api.historyLoad()) || [];
  renderLibrary();
  renderSites();

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

  state.binInfo = bin;
  state.binWarn = !bin.ytdlpExists || !bin.ffmpegExists;
  updateStatus();
  bindEvents();
})();

function updateStatus() {
  let active = 0;
  let totalKBps = 0;
  for (const job of state.jobs.values()) {
    if (job.state === 'downloading' || job.state === 'starting') active++;
    if (job.lastSpeed) totalKBps += parseSpeedKBps(job.lastSpeed);
  }
  if (els.statActive) els.statActive.textContent = String(active);
  if (els.statSpeed) els.statSpeed.textContent = active && totalKBps > 0 ? formatSpeed(totalKBps) : '—';
  document.body.classList.toggle('has-active', active > 0);
  if (els.statusDot && els.statusText) {
    if (state.binWarn) {
      els.statusDot.dataset.state = 'warn';
      els.statusText.textContent = 'Missing binaries';
    } else if (active > 0) {
      els.statusDot.dataset.state = 'ok';
      els.statusText.textContent = `${active} downloading`;
    } else {
      els.statusDot.dataset.state = 'ok';
      els.statusText.textContent = 'Ready';
    }
  }
}

function parseSpeedKBps(s) {
  const m = String(s).match(/([\d.]+)\s*([KMG]i?B\/s)/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u.startsWith('G')) return v * 1024 * 1024;
  if (u.startsWith('M')) return v * 1024;
  if (u.startsWith('K')) return v;
  return v / 1024;
}
function formatSpeed(kbps) {
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${kbps.toFixed(0)} KB/s`;
}

function refreshSettings() {
  if (els.settingsFolderHint) els.settingsFolderHint.textContent = state.folder || '';
  if (els.settingsYtdlp) els.settingsYtdlp.textContent =
    state.binInfo ? (state.binInfo.ytdlpExists ? state.binInfo.ytdlp : 'Not found — place yt-dlp.exe in ' + state.binInfo.binDir) : '';
  if (els.settingsFfmpeg) els.settingsFfmpeg.textContent =
    state.binInfo ? (state.binInfo.ffmpegExists ? state.binInfo.ffmpeg : 'Not found — place ffmpeg.exe in ' + state.binInfo.binDir) : '';
}

function bindEvents() {
  // Tabs
  $$('.side-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.side-btn[data-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
      if (tab === 'library') renderLibrary();
      if (tab === 'settings') refreshSettings();
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

  if (els.settingsBrowseBtn) {
    els.settingsBrowseBtn.addEventListener('click', async () => {
      const f = await window.api.pickFolder();
      if (f) {
        state.folder = f;
        els.folderDisplay.textContent = f;
        refreshSettings();
      }
    });
  }

  // Generic modal helper
  const bindModal = (backdrop, closeBtn, onOpen) => {
    if (!backdrop) return { open: () => {}, close: () => {} };
    const open = () => { backdrop.classList.remove('hidden'); onOpen && onOpen(); };
    const close = () => backdrop.classList.add('hidden');
    if (closeBtn) closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    return { open, close };
  };

  // About modal
  const aboutModalApi = bindModal($('aboutModal'), $('aboutModalClose'));
  const aboutBtn = $('aboutBtn');
  if (aboutBtn) aboutBtn.addEventListener('click', aboutModalApi.open);

  // Supported sites modal
  const sitesModalApi = bindModal($('sitesModal'), $('sitesModalClose'), loadSupportedSites);
  const sitesBtn = $('sitesBtn');
  if (sitesBtn) sitesBtn.addEventListener('click', sitesModalApi.open);
  const sitesFilter = $('sitesFilter');
  if (sitesFilter) sitesFilter.addEventListener('input', renderSitesList);

  // Esc closes any open modal
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach((m) => m.classList.add('hidden'));
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

  // Library
  els.libSearch.addEventListener('input', renderLibrary);
  els.libClear.addEventListener('click', () => {
    if (!state.history.length) return;
    if (!confirm('Clear all library entries? This does not delete the files.')) return;
    state.history = [];
    window.api.historySave(state.history);
    renderLibrary();
  });

  // Browser (embedded webview)
  initBrowser();

  // Search
  els.searchBtn.addEventListener('click', runSearch);
  els.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

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
  updateStatus();
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
  job.lastSpeed = speed || '';
  updateStatus();
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
  job.lastSpeed = '';
  updateStatus();
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
  updateStatus();
}

function renderLibrary() {
  const filter = (els.libSearch?.value || '').toLowerCase().trim();
  els.libraryList.innerHTML = '';

  const items = state.history
    .filter((it) => !filter || (it.title || it.url || '').toLowerCase().includes(filter))
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  if (items.length === 0) return;

  const groups = new Map();
  for (const it of items) {
    const key = groupKey(it.completedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  for (const [label, list] of groups) {
    const h = document.createElement('div');
    h.className = 'lib-group-title';
    h.textContent = label;
    els.libraryList.appendChild(h);
    for (const item of list) {
      const badge = item.mode === 'audio'
        ? `MP3${item.audioBitrate ? ' ' + item.audioBitrate : ''}`
        : (item.quality || '').toUpperCase();
      const div = document.createElement('div');
      div.className = 'lib-item';
      div.innerHTML = `
        <div class="lib-thumb">
          ${item.thumbnail ? `<img src="${escapeAttr(item.thumbnail)}" referrerpolicy="no-referrer" onerror="this.style.display='none'"/>` : ''}
          ${badge ? `<span class="lib-badge">${escapeHtml(badge)}</span>` : ''}
        </div>
        <div class="lib-info">
          <div class="lib-title">${escapeHtml(item.title || item.url)}</div>
          <div class="lib-sub">${escapeHtml(new Date(item.completedAt).toLocaleString())}</div>
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
}

function groupKey(ts) {
  if (!ts) return 'Earlier';
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  if (d >= today) return 'Today';
  if (d >= yest) return 'Yesterday';
  if (d >= weekAgo) return 'Earlier this week';
  return 'Earlier';
}

function renderSites() {
  if (!els.sitesGrid) return;
  els.sitesGrid.innerHTML = '';
  for (const s of SUPPORTED_SITES) {
    const btn = document.createElement('button');
    btn.className = 'site-tile';
    btn.type = 'button';
    btn.innerHTML = `
      <span class="site-mark" style="background:${s.color}">${escapeHtml(s.mark)}</span>
      <span>${escapeHtml(s.name)}</span>
    `;
    btn.addEventListener('click', () => bvNavigate(s.url));
    els.sitesGrid.appendChild(btn);
  }
}

function initBrowser() {
  const bv = els.bv;
  if (!bv) return;

  const setLoading = (on) => els.bvLoading.classList.toggle('hidden', !on);
  const syncNavButtons = () => {
    els.bvBack.disabled = !bv.canGoBack();
    els.bvFwd.disabled = !bv.canGoForward();
  };

  bv.addEventListener('did-start-loading', () => setLoading(true));
  bv.addEventListener('did-stop-loading', () => { setLoading(false); syncNavButtons(); });
  bv.addEventListener('did-navigate', (e) => { els.bvUrl.value = e.url; syncNavButtons(); });
  bv.addEventListener('did-navigate-in-page', (e) => { els.bvUrl.value = e.url; syncNavButtons(); });
  bv.addEventListener('new-window', (e) => { e.preventDefault?.(); bvNavigate(e.url); });

  els.bvBack.addEventListener('click', () => bv.canGoBack() && bv.goBack());
  els.bvFwd.addEventListener('click', () => bv.canGoForward() && bv.goForward());
  els.bvReload.addEventListener('click', () => bv.reload());
  els.bvUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = els.bvUrl.value.trim();
      if (v) bvNavigate(/^https?:\/\//i.test(v) ? v : `https://www.google.com/search?q=${encodeURIComponent(v)}`);
    }
  });
  els.bvDownload.addEventListener('click', () => {
    const url = bv.getURL();
    if (!url || !/^https?:/i.test(url)) {
      alert('Open a page first.');
      return;
    }
    document.querySelector('.side-btn[data-tab="new"]').click();
    els.urlInput.value = url;
    startDownload();
  });
}

function bvNavigate(url) {
  if (!els.bv) return;
  document.querySelector('.side-btn[data-tab="browser"]').click();
  els.bv.loadURL(url).catch(() => {});
}

async function runSearch() {
  const q = (els.searchInput.value || '').trim();
  els.searchResults.innerHTML = '';
  els.searchStatus.className = 'search-status';
  if (!q) { els.searchStatus.textContent = ''; return; }
  els.searchStatus.textContent = 'Searching…';
  els.searchBtn.disabled = true;
  try {
    const res = await window.api.ytSearch(q, 10);
    if (!res.ok) {
      els.searchStatus.className = 'search-status error';
      els.searchStatus.textContent = res.error || 'Search failed.';
      return;
    }
    if (!res.items.length) {
      els.searchStatus.textContent = 'No results.';
      return;
    }
    els.searchStatus.textContent = `${res.items.length} results`;
    for (const r of res.items) renderSearchResult(r);
  } finally {
    els.searchBtn.disabled = false;
  }
}

function renderSearchResult(r) {
  const div = document.createElement('div');
  div.className = 'search-item';
  div.innerHTML = `
    <div class="res-thumb">${r.thumbnail ? `<img src="${escapeAttr(r.thumbnail)}" referrerpolicy="no-referrer" onerror="this.style.display='none'"/>` : ''}</div>
    <div class="res-info">
      <div class="res-title">${escapeHtml(r.title)}</div>
      <div class="res-sub">${escapeHtml(r.channel || '')}${r.duration ? ' · ' + formatDuration(r.duration) : ''}</div>
    </div>
    <div class="res-actions">
      <button class="ghost-btn add-video">Video</button>
      <button class="ghost-btn add-audio">MP3</button>
    </div>
  `;
  div.querySelector('.add-video').addEventListener('click', () => addFromSearch(r, 'video'));
  div.querySelector('.add-audio').addEventListener('click', () => addFromSearch(r, 'audio'));
  els.searchResults.appendChild(div);
}

function addFromSearch(r, mode) {
  document.querySelector('.nav-btn[data-tab="new"]').click();
  els.urlInput.value = r.url;
  switchMode(mode);
  startDownload();
}

function formatDuration(s) {
  s = Math.floor(Number(s) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

let extractorsCache = null;
async function loadSupportedSites() {
  const body = $('sitesListBody');
  const count = $('sitesCount');
  if (extractorsCache) { renderSitesList(); return; }
  if (body) body.innerHTML = '<div class="modal-loading">Loading from yt-dlp…</div>';
  if (count) count.textContent = '';
  const res = await window.api.listExtractors();
  if (!res.ok) {
    if (body) body.innerHTML = `<div class="modal-empty">Could not fetch list. ${escapeHtml(res.error || '')}</div>`;
    return;
  }
  extractorsCache = res.list;
  renderSitesList();
}

function renderSitesList() {
  const body = $('sitesListBody');
  const count = $('sitesCount');
  const filterEl = $('sitesFilter');
  if (!body || !extractorsCache) return;
  const f = (filterEl?.value || '').toLowerCase().trim();
  const list = f ? extractorsCache.filter((s) => s.toLowerCase().includes(f)) : extractorsCache;
  if (count) count.textContent = `${list.length}${f ? ' of ' + extractorsCache.length : ''} sites`;
  if (!list.length) {
    body.innerHTML = '<div class="modal-empty">No matches.</div>';
    return;
  }
  body.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const name of list) {
    const div = document.createElement('div');
    div.className = 'modal-list-item';
    div.textContent = name;
    frag.appendChild(div);
  }
  body.appendChild(frag);
}

// ---------- License gate ----------

async function runLicenseGate() {
  const lock = document.getElementById('lockScreen');
  if (!lock || !window.api?.licenseStatus) return;

  const status = await window.api.licenseStatus();
  if (status.licensed) {
    lock.classList.add('hidden');
  } else {
    await showLockScreen();
  }

  // If revoked while running, lock again
  window.api.onLicenseRevoked(() => {
    const sub = document.getElementById('lockSub');
    if (sub) sub.textContent = 'Your license was revoked. Contact support or enter a new key.';
    showLockScreen();
  });
}

function showLockScreen() {
  return new Promise((resolve) => {
    const lock = document.getElementById('lockScreen');
    lock.classList.remove('hidden');

    const tabs = lock.querySelectorAll('[data-lk-mode]');
    const panes = lock.querySelectorAll('[data-lk-pane]');
    tabs.forEach((t) => t.addEventListener('click', () => {
      const m = t.dataset.lkMode;
      tabs.forEach((x) => x.classList.toggle('active', x === t));
      panes.forEach((p) => p.classList.toggle('hidden', p.dataset.lkPane !== m));
    }, { once: false }));

    const emailInput = document.getElementById('lkEmail');
    const emailBtn   = document.getElementById('lkEmailBtn');
    const emailMsg   = document.getElementById('lkEmailMsg');
    const keyInput   = document.getElementById('lkKey');
    const activateBtn= document.getElementById('lkActivateBtn');
    const keyMsg     = document.getElementById('lkKeyMsg');

    const setMsg = (el, text, cls) => {
      el.className = 'lock-msg' + (cls ? ' ' + cls : '');
      el.textContent = text;
    };

    emailBtn.onclick = async () => {
      const email = (emailInput.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setMsg(emailMsg, 'Enter a valid email.', 'error'); return;
      }
      emailBtn.disabled = true;
      setMsg(emailMsg, 'Requesting key…');
      const r = await window.api.licenseSignup(email);
      if (!r.ok) {
        emailBtn.disabled = false;
        setMsg(emailMsg, r.error || 'Signup failed.', 'error');
        return;
      }
      setMsg(emailMsg, `Got key ${r.key}. Activating…`, 'success');
      const a = await window.api.licenseActivate(r.key);
      emailBtn.disabled = false;
      if (a.ok) {
        setMsg(emailMsg, 'Activated. Welcome!', 'success');
        setTimeout(() => {
          document.getElementById('lockScreen').classList.add('hidden');
          resolve();
        }, 600);
      } else {
        setMsg(emailMsg, a.error || 'Activation failed.', 'error');
      }
    };

    activateBtn.onclick = async () => {
      const key = (keyInput.value || '').trim();
      if (!key) { setMsg(keyMsg, 'Enter a key.', 'error'); return; }
      activateBtn.disabled = true;
      setMsg(keyMsg, 'Activating…');
      const a = await window.api.licenseActivate(key);
      activateBtn.disabled = false;
      if (a.ok) {
        setMsg(keyMsg, 'Activated. Welcome!', 'success');
        setTimeout(() => {
          document.getElementById('lockScreen').classList.add('hidden');
          resolve();
        }, 600);
      } else {
        setMsg(keyMsg, a.error || 'Activation failed.', 'error');
      }
    };
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }
