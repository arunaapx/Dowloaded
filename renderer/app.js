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
  pendingDownloadOptions: null,
  // Jobs waiting for a slot, oldest first. They are real jobs in state.jobs
  // with state 'queued', so a queued item has a card from the moment it is
  // added instead of appearing only once it starts.
  queue: [],
  queuePaused: false,
  queueLimit: 3,
  // Sort finished files into Video/ and Music/ instead of one flat heap.
  sortIntoFolders: false,
  // Epoch ms the held queue should release itself at, or null.
  queueStartAt: null,
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
  statLicense: $('statLicense'),
  profileCard: $('profileCard'),
  profileAvatar: $('profileAvatar'),
  profileEmail: $('profileEmail'),
  profileKey: $('profileKey'),
  profileDays: $('profileDays'),
  profileState: $('profileState'),
  profileMeter: $('profileMeter'),
  profileSignOut: $('profileSignOut'),
  settingsBrowseBtn: $('settingsBrowseBtn'),
  settingsFolderHint: $('settingsFolderHint'),
  settingsLicenseProfile: $('settingsLicenseProfile'),
  settingsLicenseExpiry: $('settingsLicenseExpiry'),
  settingsEngine: $('settingsEngine'),
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
  // The licence check is a network round trip, measured at about 950ms. It used
  // to run before anything was drawn, so the window sat empty for a second on
  // every launch. It now runs alongside the rest of start-up; the lock screen
  // is up from the first frame and comes down only when the check passes, so
  // nothing unlocked is ever on screen.
  const licenceGate = runLicenseGate();

  state.folder = await window.api.defaultDownloadFolder();
  els.folderDisplay.textContent = state.folder;

  state.history = (await window.api.historyLoad()) || [];
  renderLibrary();
  renderSites();

  // The thin client only needs ffmpeg/ffprobe (for merge + MP3). Extraction is
  // done server-side, so yt-dlp is no longer required on this device.
  const bin = await window.api.checkBinaries();
  // Say what the user has lost and how to fix it, not which tool is missing.
  if (!bin.ffmpegExists || !bin.ffprobeExists) {
    els.binWarning.classList.remove('hidden');
    els.binWarning.innerHTML = `
      <strong>Some of Velox is missing.</strong> 1080p and above, and MP3 audio,
      will not work until it is repaired. Reinstall Velox to fix this.
    `;
  }

  state.binInfo = bin;
  state.binWarn = !bin.ffmpegExists || !bin.ffprobeExists;
  updateStatus();
  bindEvents();
  initYouTubeSignIn();
  initNetflixSettings();
  initProxySettings();
  initQueueControls();
  initUpdateGate();
  initSpeedLimit();
  initClipboardWatch();
  // Remembered locally: it only decides where files land, so it never needs the
  // main process.
  const sortBox = document.getElementById('sortIntoFolders');
  if (sortBox) {
    state.sortIntoFolders = localStorage.getItem('velox.sortIntoFolders') === '1';
    sortBox.checked = state.sortIntoFolders;
    sortBox.addEventListener('change', () => {
      state.sortIntoFolders = sortBox.checked;
      try { localStorage.setItem('velox.sortIntoFolders', state.sortIntoFolders ? '1' : '0'); } catch {}
    });
  }
  // Three places used to spell the version out by hand and had drifted apart
  // from package.json; now they all read the running build.
  if (window.api.appVersion) {
    window.api.appVersion().then((v) => {
      if (!v) return;
      document.querySelectorAll('.js-app-version').forEach((el) => { el.textContent = 'v' + v; });
    }).catch(() => {});
  }

  // Nothing below depends on it, but an unhandled rejection here would be
  // invisible, so it is awaited at the end rather than dropped.
  await licenceGate;
})();

// Links the browser tab found on the current page. Confirmed before anything
// is queued: forty downloads started by one click, with no warning, is not a
// feature anyone wants twice.
function handlePageLinks({ links, title }) {
  const found = Array.isArray(links) ? links : [];
  if (!found.length) {
    handleLog({ message: 'No video links found on that page.' });
    alert('No video links found on this page.');
    return;
  }
  const fresh = found.filter((l) => {
    for (const job of state.jobs.values()) if (job.url === l.url) return false;
    return true;
  });
  if (!fresh.length) {
    alert('Everything on this page is already in the queue.');
    return;
  }

  const where = title ? `“${String(title).slice(0, 50)}”` : 'this page';
  const skipped = found.length - fresh.length;
  const note = skipped ? `
${skipped} already queued and will be skipped.` : '';
  if (!confirm(`${fresh.length} video${fresh.length === 1 ? '' : 's'} found on ${where}.${note}

Add them to the queue?`)) return;

  for (const l of fresh) {
    try { queueDownload(l.url, {}); } catch { /* keep the rest going */ }
  }
  handleLog({ message: `Queued ${fresh.length} link${fresh.length === 1 ? '' : 's'} from the page.` });
  openTab('new');
}

// ---------- clipboard watch ----------
//
// Copying a link is how most downloads start, so the app offers to take it
// instead of making the user find the paste button. It only ever OFFERS: an app
// that starts downloading whatever lands on the clipboard is one people
// uninstall, and the clipboard carries passwords as often as it carries links.
function initClipboardWatch() {
  const bar = document.getElementById('clipOffer');
  const label = document.getElementById('clipUrl');
  const use = document.getElementById('clipUse');
  const dismiss = document.getElementById('clipDismiss');
  if (!bar || !window.api?.readClipboard) return;

  // Whatever is already on the clipboard when the app opens was not copied for
  // us, so it is recorded as seen and never offered.
  let lastSeen = null;
  let offering = null;

  const hide = () => { bar.classList.add('hidden'); offering = null; };

  const offer = (url) => {
    offering = url;
    label.textContent = url.length > 64 ? url.slice(0, 61) + '…' : url;
    bar.classList.remove('hidden');
  };

  const looksDownloadable = (text) => {
    const t = String(text || '').trim();
    if (!t || t.length > 2000 || /\s/.test(t)) return false;
    try {
      const u = new URL(t);
      if (!/^https?:$/.test(u.protocol)) return false;
      // Our own pages are not downloads, and neither is a bare domain.
      return !!u.hostname && u.hostname.includes('.') && (u.pathname.length > 1 || !!u.search);
    } catch { return false; }
  };

  const tick = async () => {
    let text;
    try { text = await window.api.readClipboard(); } catch { return; }
    if (text === lastSeen) return;
    lastSeen = text;
    if (!looksDownloadable(text)) { hide(); return; }
    // Already queued or downloading: offering it again would only invite a
    // duplicate.
    for (const job of state.jobs.values()) if (job.url === text) return;
    offer(text.trim());
  };

  use.addEventListener('click', () => {
    const url = offering;
    hide();
    if (!url) return;
    if (!state.folder) { alert('Pick a save folder first.'); return; }
    if (typeof maybeOpenPlaylist === 'function') {
      maybeOpenPlaylist(url).then((handled) => { if (!handled) queueDownload(url, {}); });
    } else {
      queueDownload(url, {});
    }
    openTab('new');
  });
  dismiss.addEventListener('click', hide);

  // Record what is already there, then watch. One second is fast enough to feel
  // immediate and slow enough to cost nothing.
  window.api.readClipboard().then((t) => { lastSeen = t; }).catch(() => {});
  setInterval(tick, 1000);
}

// ---------- download speed limit ----------
//
// yt-dlp takes --limit-rate, so this is a cap the engine enforces itself. The
// point is not to download slowly: it is that a download running flat out makes
// everything else on a home connection unusable while it runs.
function initSpeedLimit() {
  const sel = document.getElementById('speedLimit');
  const hint = document.getElementById('speedLimitHint');
  if (!sel || !window.api?.speedLimitGet) return;

  const base = hint ? hint.textContent : '';
  const describe = (bps) => {
    if (!hint) return;
    hint.textContent = bps
      ? `Downloads are capped at ${humanRate(bps)}. Applies to the next download; ones already running keep their current speed.`
      : base;
  };

  window.api.speedLimitGet().then((st) => {
    const bps = (st && st.bytesPerSecond) || 0;
    // A value saved before these options existed still has to select something.
    if ([...sel.options].some((o) => Number(o.value) === bps)) sel.value = String(bps);
    describe(bps);
  }).catch(() => {});

  sel.addEventListener('change', async () => {
    const res = await window.api.speedLimitSet(Number(sel.value) || 0);
    describe((res && res.bytesPerSecond) || 0);
  });
}

function humanRate(bps) {
  return bps >= 1048576
    ? `${Math.round((bps / 1048576) * 10) / 10} MB/s`
    : `${Math.round(bps / 1024)} KB/s`;
}

// ---------- mandatory update ----------
//
// An out-of-date build should not be usable: the licence server, the site
// adapters and YouTube itself all move, and an old copy fails in ways the user
// reads as "Velox is broken".
//
// The gate is raised only when an update is CONFIRMED available. A machine with
// no internet, or one that cannot reach the update server, is never locked out
// of software it already paid for - that would turn our outage into their
// outage.
function initUpdateGate() {
  const gate = document.getElementById('updateGate');
  if (!gate || !window.api?.onUpdateAvailable) return;

  const body = document.getElementById('updateGateBody');
  const fill = document.getElementById('updateGateFill');
  const pct = document.getElementById('updateGatePct');
  const btn = document.getElementById('updateGateBtn');
  const retry = document.getElementById('updateGateRetry');
  const note = document.getElementById('updateGateNote');
  let version = '';

  const raise = () => {
    gate.classList.remove('hidden');
    // The embedded browser keeps keyboard focus in its own process, which would
    // leave the button here unreachable.
    setBrowserViewActive(false);
  };

  window.api.onUpdateAvailable((d) => {
    version = (d && d.version) || '';
    body.textContent = version
      ? `Velox ${version} is required. It is downloading now.`
      : 'A required update is downloading now.';
    pct.textContent = 'Starting…';
    fill.style.width = '0%';
    btn.hidden = true;
    retry.hidden = true;
    note.textContent = '';
    raise();
  });

  window.api.onUpdateProgress((d) => {
    const n = Math.max(0, Math.min(100, Math.round((d && d.percent) || 0)));
    fill.style.width = n + '%';
    pct.textContent = n + '%';
  });

  window.api.onUpdateDownloaded(() => {
    fill.style.width = '100%';
    pct.textContent = 'Ready to install';
    body.textContent = version
      ? `Velox ${version} is ready. Restarting finishes the update.`
      : 'The update is ready. Restarting finishes it.';
    btn.hidden = false;
    btn.focus();
    raise();
  });

  window.api.onUpdateError((d) => {
    // Only meaningful once the gate is already up: an error during the routine
    // background check must not raise it.
    if (gate.classList.contains('hidden')) return;
    pct.textContent = '';
    note.textContent = (d && d.error) ? `Could not finish: ${d.error}` : 'The download did not finish.';
    retry.hidden = false;
  });

  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Restarting…';
    window.api.updateInstall();
  });
  retry.addEventListener('click', () => {
    retry.hidden = true;
    note.textContent = '';
    pct.textContent = 'Starting…';
    window.api.updateCheck();
  });

  // A window opened while an update was already downloading (the check runs
  // before the renderer finishes loading) still has to show the gate.
  window.api.updateStatus().then((st) => {
    if (!st || !st.status) return;
    if (st.status === 'downloading' || st.status === 'ready') {
      version = st.version || '';
      body.textContent = version ? `Velox ${version} is required.` : 'A required update is downloading.';
      fill.style.width = (st.percent || 0) + '%';
      pct.textContent = st.status === 'ready' ? 'Ready to install' : (st.percent || 0) + '%';
      btn.hidden = st.status !== 'ready';
      raise();
    }
  }).catch(() => {});
}

// ---------- "Use my YouTube sign-in" ----------
//
// Off by default. Signed-in Google cookies break videos that work anonymously,
// so this is only worth turning on for the ones YouTube refuses outright.
function initYouTubeSignIn() {
  const toggle = document.getElementById('ytSignInToggle');
  const hint = document.getElementById('ytSignInHint');
  if (!toggle || !hint || !window.api?.ytSignInGet) return;

  const base = hint.textContent.trim();
  const paint = (st) => {
    toggle.checked = !!st.enabled;
    if (st.enabled && !st.signedIn) {
      // Turning it on while signed out does nothing at all, so say so rather
      // than letting the user think the problem is fixed.
      hint.innerHTML = '<strong>You are not signed in to YouTube yet.</strong> '
        + 'Open the Browser tab, sign in, then come back — this stays off until you do.';
    } else if (st.enabled) {
      hint.textContent = 'On. Your YouTube sign-in is sent with downloads. '
        + 'If a video that used to work starts failing, turn this off again.';
    } else {
      hint.textContent = base;
    }
  };

  window.api.ytSignInGet().then(paint);
  toggle.addEventListener('change', async () => {
    await window.api.ytSignInSet(toggle.checked);
    paint(await window.api.ytSignInGet());
  });
}

function initNetflixSettings() {
  const emailInput = document.getElementById('netflixEmail');
  const passInput = document.getElementById('netflixPassword');
  const proxyInput = document.getElementById('netflixProxy');
  const fetchProxyBtn = document.getElementById('fetchProxyBtn');
  const cookiesInput = document.getElementById('netflixCookies');
  const saveBtn = document.getElementById('saveNetflixBtn');
  const status = document.getElementById('netflixStatus');

  if (!emailInput || !passInput || !cookiesInput || !saveBtn || !window.api?.netflixCredsSet) return;

  window.api.netflixCredsGet().then((creds) => {
    if (creds) {
      emailInput.value = creds.email || '';
      passInput.value = creds.password || '';
      if (proxyInput) proxyInput.value = creds.proxy || '';
      cookiesInput.value = creds.cookies || '';
    }
  });

  if (fetchProxyBtn) {
    fetchProxyBtn.addEventListener('click', async () => {
      fetchProxyBtn.disabled = true;
      const oldText = fetchProxyBtn.textContent;
      fetchProxyBtn.textContent = 'Testing proxies...';
      try {
        const res = await window.api.proxyFindBest();
        if (res.ok) {
          proxyInput.value = res.proxy;
          status.style.color = 'var(--green, #4caf50)';
          status.textContent = `Found working proxy (${res.latency}ms latency). Click Save.`;
        } else {
          status.style.color = 'var(--red, #f44)';
          status.textContent = 'All checked proxies were dead. Try again.';
        }
      } catch (e) {
        status.style.color = 'var(--red, #f44)';
        status.textContent = 'Failed to fetch proxy: ' + e.message;
      } finally {
        fetchProxyBtn.disabled = false;
        fetchProxyBtn.textContent = oldText;
      }
    });
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const steps = [
      'Saving email & password...',
      'Setting proxy...',
      'Converting cookies...',
      'Saving cookies file...',
      'Verifying...',
    ];
    
    for (let i = 0; i < steps.length; i++) {
      status.style.color = 'var(--text-secondary, #aaa)';
      status.textContent = `[${i + 1}/${steps.length}] ${steps[i]}`;
      await new Promise(r => setTimeout(r, 400));
    }
    
    try {
      const proxy = proxyInput ? proxyInput.value.trim() : '';
      const res = await window.api.netflixCredsSet(emailInput.value.trim(), passInput.value.trim(), cookiesInput.value.trim(), proxy);
      if (res.ok) {
        status.style.color = 'var(--green, #4caf50)';
        status.textContent = '✅ All saved! Status: Online';
      } else {
        status.style.color = 'var(--red, #f44)';
        status.textContent = '❌ Save failed. Check config file exists.';
      }
    } catch (e) {
      status.style.color = 'var(--red, #f44)';
      status.textContent = '❌ Error: ' + e.message;
    } finally {
      saveBtn.disabled = false;
    }
  });
}

// ---------- proxy setting ----------
//
// A second exit IP for the download engine, for when YouTube rate-limits the
// user's connection. Torrents are not routed through it (the engine has no
// SOCKS support), which is why the row in Settings says so out loud rather
// than calling this a VPN.
function initProxySettings() {
  const url = document.getElementById('proxyUrl');
  const enabled = document.getElementById('proxyEnabled');
  const scope = document.getElementById('proxyScope');
  const testBtn = document.getElementById('proxyTestBtn');
  const status = document.getElementById('proxyStatus');
  if (!url || !enabled || !scope || !testBtn || !status || !window.api?.proxyGet) return;

  const say = (text, kind) => {
    status.textContent = text || '';
    status.className = 'proxy-status' + (kind ? ' ' + kind : '');
  };

  const paint = (cfg) => {
    url.value = cfg.url || '';
    enabled.checked = !!cfg.enabled;
    scope.value = cfg.scope || 'fallback';
  };

  const push = async (patch) => {
    const res = await window.api.proxySet(patch);
    paint(res);
    // A rejected change must not leave the toggle looking as if it took, so
    // repaint from what the main process actually stored either way.
    if (res.ok === false) say(res.error, 'bad');
    else say('');
    return res;
  };

  window.api.proxyGet().then(paint);

  // Save on blur rather than per keystroke: a half-typed address is invalid and
  // would spray errors while the user is still typing it.
  url.addEventListener('blur', () => {
    if (url.value.trim() === '') { push({ url: '' }); return; }
    push({ url: url.value });
  });
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') url.blur(); });
  enabled.addEventListener('change', () => push({ url: url.value, enabled: enabled.checked }));
  scope.addEventListener('change', () => push({ scope: scope.value }));

  testBtn.addEventListener('click', async () => {
    const candidate = url.value.trim();
    if (!candidate) { say('Enter a proxy address first.', 'bad'); return; }
    testBtn.disabled = true;
    say('Testing…', 'busy');
    try {
      const res = await window.api.proxyTest(candidate);
      if (res.ok) {
        say(res.directIp
          ? `Working. Sites now see ${res.ip} instead of ${res.directIp}.`
          : `Working. Sites now see ${res.ip}.`, 'ok');
      } else {
        say(res.error || 'The proxy did not answer.', 'bad');
      }
    } finally {
      testBtn.disabled = false;
    }
  });
}

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
  pushTaskbarProgress();
}

// Averaged across everything still to do, queued jobs included: a queue of
// forty that has finished one is 2.5% done, not 100% done with one file.
let lastTaskbarValue = null;
function pushTaskbarProgress() {
  if (!window.api?.taskbarProgress) return;
  let counted = 0;
  let sum = 0;
  for (const job of state.jobs.values()) {
    if (job.state === 'downloading' || job.state === 'starting') { counted++; sum += (job.percent || 0) / 100; }
    else if (job.state === 'queued') { counted++; }
  }
  // -1 is Electron's "no bar at all", which is what an idle app should show.
  const value = counted ? Math.min(1, sum / counted) : -1;
  // Whole percentages only: the taskbar cannot show more, and this would
  // otherwise fire an IPC message on every progress tick of every job.
  const rounded = value < 0 ? -1 : Math.round(value * 100) / 100;
  if (rounded === lastTaskbarValue) return;
  lastTaskbarValue = rounded;
  window.api.taskbarProgress(rounded).catch(() => {});
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
  // Report readiness, not filenames or paths.
  if (els.settingsEngine) {
    const b = state.binInfo;
    els.settingsEngine.textContent = !b
      ? ''
      : (b.ytdlpExists && b.ffmpegExists && b.ffprobeExists)
        ? 'Ready'
        : 'Incomplete — reinstall Velox to repair it';
  }
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
      if (tab === 'browser') ensureBrowserLoaded();
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
  if (els.profileSignOut) els.profileSignOut.addEventListener('click', signOutLicense);

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
  setupUpdatePill();
}

// The update pill reports progress but only turns into a button once the build
// is on disk — restarting mid-download would just throw the bytes away.
function setupUpdatePill() {
  const pill = document.getElementById('updatePill');
  if (!pill) return;

  function show(state, text) {
    pill.dataset.state = state;
    pill.textContent = text;
    pill.classList.remove('hidden');
  }

  window.api.onUpdateAvailable((d) => show('downloading', 'Downloading v' + d.version + '…'));
  window.api.onUpdateProgress((d) => show('downloading', 'Downloading update ' + d.percent + '%'));
  window.api.onUpdateDownloaded((d) => show('ready', 'v' + d.version + ' ready — Restart'));
  window.api.onUpdateError(() => pill.classList.add('hidden'));

  pill.addEventListener('click', async () => {
    if (pill.dataset.state !== 'ready') return;
    pill.textContent = 'Restarting…';
    await window.api.updateInstall();
  });

  // A download that finished before this tab wired up still needs reporting.
  window.api.updateStatus().then((st) => {
    if (!st) return;
    if (st.status === 'ready') show('ready', 'v' + st.version + ' ready — Restart');
    else if (st.status === 'downloading') show('downloading', 'Downloading update ' + st.percent + '%');
  }).catch(() => {});
}
function handleBridgeDownload(data) {
  openTab('new');
  els.urlInput.value = data.url || '';
  state.pendingDownloadOptions = {
    referer: data.referer || data.sourcePage || '',
    sourcePage: data.sourcePage || '',
    detectedUrl: data.detectedUrl || '',
    bridgeTitle: data.title || '',
  };
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

function openTab(tab) {
  const btn = document.querySelector(`.side-btn[data-tab="${tab}"]`);
  if (btn) btn.click();
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
  const urls = parseDownloadInputs(els.urlInput.value);
  if (!urls.length) {
    els.urlInput.focus();
    return;
  }
  if (!state.folder) {
    alert('Pick a save folder first.');
    return;
  }

  // One playlist link pasted on its own opens the picker instead of queueing a
  // single video. With several links pasted at once the picker would have to
  // ask about each in turn, so those stay a plain batch.
  if (urls.length === 1 && typeof maybeOpenPlaylist === 'function') {
    const handled = await maybeOpenPlaylist(urls[0]);
    if (handled) { els.urlInput.value = ''; return; }
  }

  els.urlInput.value = '';
  const pendingOptions = state.pendingDownloadOptions || {};
  state.pendingDownloadOptions = null;
  for (const url of urls) {
    await queueDownload(url, pendingOptions);
  }
}

function parseDownloadInputs(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const matches = raw.match(/https?:\/\/[^\s<>"']+/gi);
  const values = matches && matches.length ? matches : raw.split(/\s+/);
  return values
    .map((url) => url.trim().replace(/[),.;]+$/g, ''))
    .filter(Boolean);
}

async function queueDownload(url, extra = {}) {
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
    referer: extra.referer || '',
    sourcePage: extra.sourcePage || '',
    detectedUrl: extra.detectedUrl || '',
    vContainer: advanced ? state.vContainer : 'mp4',
    vCodec: advanced ? state.vCodec : 'auto',
    vBitrate: advanced ? state.vBitrate : 0,
    aFormat: advanced ? state.aFormat : 'mp3',
  };
  if (extra.bridgeTitle) job.title = extra.bridgeTitle;

  // Where the file lands: the save folder, then an optional category folder,
  // then an optional playlist folder inside that. A playlist of songs ends up
  // in Music/<playlist>/, which is where someone would go looking for it.
  const parts = [];
  if (state.sortIntoFolders) parts.push(job.mode === 'audio' ? 'Music' : 'Video');
  if (extra.playlistFolder) parts.push(extra.playlistFolder);
  if (parts.length) {
    job.folder = parts.reduce((acc, part) => joinPath(acc, part), state.folder);
    job.playlistIndex = extra.playlistPrefix || '';
    job.outputTemplate = joinPath(job.folder, `${job.playlistIndex}%(title).70s [%(id)s].%(ext)s`);
  }

  job.durationSec = 0;
  job.state = 'queued';
  state.jobs.set(id, job);
  state.queue.push(id);
  renderJob(job);
  updateStatus();
  pumpQueue();
  return id;
}

// How many jobs are actually working. Queued and failed ones do not count, so
// a failure frees the slot it was holding.
function runningCount() {
  let n = 0;
  for (const job of state.jobs.values()) {
    if (job.state === 'starting' || job.state === 'downloading') n++;
  }
  return n;
}

// Start jobs until the limit is reached. Safe to call at any time: it is the
// single place a queued job turns into a running one.
function pumpQueue() {
  while (!state.queuePaused && state.queue.length && runningCount() < state.queueLimit) {
    const id = state.queue.shift();
    const job = state.jobs.get(id);
    if (!job || job.state !== 'queued') continue;   // cancelled while waiting
    beginJob(job);
  }
  updateQueueUi();
}

async function beginJob(job) {
  const id = job.id;
  const url = job.url;
  job.state = 'starting';
  const card = document.getElementById(id);
  if (card) {
    card.classList.remove('queued');
    const st = card.querySelector('.job-state');
    if (st) { st.textContent = 'Starting…'; st.className = 'job-state'; }
    const pauseBtn = card.querySelector('.pause-btn');
    const jumpBtn = card.querySelector('.jump-btn');
    if (pauseBtn) pauseBtn.hidden = false;
    if (jumpBtn) jumpBtn.hidden = true;
  }
  updateStatus();
  updateQueueUi();

  // Start downloading straight away. The metadata probe below costs ~6s on
  // YouTube and only supplies the card's title and thumbnail, so it must run
  // ALONGSIDE the download, never in front of it — waiting for it used to
  // double the time between clicking Download and the first byte landing.
  const downloading = window.api.clientDownload(job);

  window.api.clientExtract(url).then((info) => {
    if (!state.jobs.has(id)) return;            // cancelled while probing
    if (info && info.ok && info.meta) {
      if (info.meta.title) job.title = info.meta.title;
      if (info.meta.thumbnail) job.thumbnail = info.meta.thumbnail;
      job.durationSec = info.meta.duration || 0;
      updateJobCard(job);
    }
    // A probe failure is not reported: the download is the source of truth and
    // raises its own error if the link is genuinely bad.
  }).catch(() => {});

  const startResult = await downloading;
  if (!startResult?.ok) {
    handleDone({ id, ok: false, error: startResult?.error || 'License is not active.' });
  }
}

// The renderer has no path module, and the folder the user picked can be a
// Windows path or a POSIX one depending on the platform.
const BACKSLASH = String.fromCharCode(92);

function joinPath(base, name) {
  const b = String(base || '');
  // A POSIX separator only when the path clearly uses one; Windows otherwise,
  // which is also the right default for an empty base.
  const sep = b.indexOf('/') !== -1 && b.indexOf(BACKSLASH) === -1 ? '/' : BACKSLASH;
  return b.replace(/[\\/]+$/, '') + sep + name;
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
      <button class="ctrl-btn jump-btn" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
        Start now
      </button>
      <button class="ctrl-btn pause-btn">
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
        <span class="pause-label">Pause</span>
      </button>
      <button class="ctrl-btn retry-btn" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><polyline points="20 4 20 10 14 10"/></svg>
        Retry
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
  // Queued jobs go to the bottom, running ones to the top, so the grid reads
  // in the order things will actually happen.
  if (job.state === 'queued') {
    div.classList.add('queued');
    div.querySelector('.job-state').textContent = 'Queued';
    div.querySelector('.pause-btn').hidden = true;
    div.querySelector('.jump-btn').hidden = false;
    els.activeGrid.appendChild(div);
  } else {
    els.activeGrid.prepend(div);
  }

  div.querySelector('.jump-btn').addEventListener('click', () => startNow(job.id));
  div.querySelector('.pause-btn').addEventListener('click', () => togglePause(job.id));
  div.querySelector('.retry-btn').addEventListener('click', () => retryJob(job.id));
  div.querySelector('.cancel-btn').addEventListener('click', () => cancelJob(job.id));
  div.querySelector('.open-btn').addEventListener('click', () => window.api.openFolder(job.folder));
}

// Header counts, the hold button, and the "3rd in line" text on each queued
// card. Called whenever the queue or a job's state changes.
function updateQueueUi() {
  const running = runningCount();
  const waiting = state.queue.length;

  const title = document.getElementById('downloadsTitle');
  if (title) {
    title.textContent = waiting
      ? `Downloads — ${running} running, ${waiting} queued`
      : 'Downloads';
  }

  const summary = document.getElementById('queueSummary');
  if (summary) {
    if (state.queuePaused && waiting) summary.textContent = `Queue held · ${waiting} waiting`;
    else if (waiting) summary.textContent = `${waiting} waiting for a free slot`;
    else if (running) summary.textContent = `${running} downloading`;
    else summary.textContent = 'Nothing downloading';
  }

  const hold = document.getElementById('queueHoldBtn');
  if (hold) {
    hold.hidden = waiting === 0 && !state.queuePaused;
    hold.textContent = state.queuePaused ? 'Resume queue' : 'Hold queue';
  }

  const schedWrap = document.getElementById('queueScheduleWrap');
  if (schedWrap) schedWrap.hidden = waiting === 0 && !state.queueStartAt;

  if (state.queueStartAt && summary) {
    const mins = Math.max(0, Math.round((state.queueStartAt - Date.now()) / 60000));
    const when = new Date(state.queueStartAt)
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const left = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    summary.textContent = `${waiting} waiting · starts at ${when} (in ${left}) · keep Velox open`;
  }

  state.queue.forEach((id, i) => {
    const card = document.getElementById(id);
    if (!card) return;
    const st = card.querySelector('.job-state');
    if (st) st.textContent = state.queuePaused ? 'Held' : (i === 0 ? 'Next' : `Queued · ${i + 1}${ordinal(i + 1)}`);
    // Only the first few can usefully be jumped ahead of.
    const jump = card.querySelector('.jump-btn');
    if (jump) jump.hidden = i === 0;
  });
}

function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
}

// Move a queued job to the front and, if a slot is free, start it at once.
function startNow(id) {
  const at = state.queue.indexOf(id);
  if (at <= 0) return;
  state.queue.splice(at, 1);
  state.queue.unshift(id);
  const card = document.getElementById(id);
  // Put the card where its new position says it is.
  if (card) {
    const firstQueued = state.queue.slice(1).map((q) => document.getElementById(q)).find(Boolean);
    if (firstQueued) els.activeGrid.insertBefore(card, firstQueued);
  }
  pumpQueue();
}

// Turn "01:30" into the next moment that clock time occurs. 1:30 typed at 11pm
// means tonight; typed at 2am it means tomorrow, not sixteen hours ago.
function nextOccurrence(hhmm, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function initQueueControls() {
  const limit = document.getElementById('queueLimit');
  const hold = document.getElementById('queueHoldBtn');
  const schedWrap = document.getElementById('queueScheduleWrap');
  const startAt = document.getElementById('queueStartAt');
  const schedClear = document.getElementById('queueScheduleClear');

  if (startAt) {
    startAt.addEventListener('change', () => {
      const when = nextOccurrence(startAt.value);
      if (!when) { state.queueStartAt = null; updateQueueUi(); return; }
      state.queueStartAt = when;
      // Scheduling implies holding: otherwise the queue drains before the hour
      // it was told to wait for.
      state.queuePaused = true;
      if (schedClear) schedClear.hidden = false;
      updateQueueUi();
    });
  }
  if (schedClear) {
    schedClear.addEventListener('click', () => {
      state.queueStartAt = null;
      if (startAt) startAt.value = '';
      schedClear.hidden = true;
      updateQueueUi();
    });
  }

  // One timer for the whole queue. Checked every 20s rather than with a single
  // long timeout, so a laptop that slept through the hour still starts on wake.
  setInterval(() => {
    if (!state.queueStartAt) return;
    if (Date.now() < state.queueStartAt) { updateQueueUi(); return; }
    state.queueStartAt = null;
    state.queuePaused = false;
    if (startAt) startAt.value = '';
    if (schedClear) schedClear.hidden = true;
    handleLog({ message: 'Scheduled start reached — the queue is running.' });
    pumpQueue();
  }, 20000);

  const saved = parseInt(localStorage.getItem('velox.queueLimit') || '', 10);
  if (Number.isFinite(saved) && saved > 0) state.queueLimit = saved;
  if (limit) {
    limit.value = String(state.queueLimit);
    limit.addEventListener('change', () => {
      state.queueLimit = Math.max(1, parseInt(limit.value, 10) || 3);
      try { localStorage.setItem('velox.queueLimit', String(state.queueLimit)); } catch {}
      // Raising the limit should take effect immediately; lowering it never
      // stops a download already running.
      pumpQueue();
    });
  }

  if (hold) {
    hold.addEventListener('click', () => {
      state.queuePaused = !state.queuePaused;
      if (!state.queuePaused) pumpQueue();
      else updateQueueUi();
    });
  }
  updateQueueUi();
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
  message = cleanUserMessage(message);
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
  // Whether it finished or failed, the slot it held is free now. Queued jobs
  // used to sit still until the NEXT event happened to call the pump.
  setTimeout(pumpQueue, 0);
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
    const message = cleanUserMessage(error) || `Download failed (code ${code})`;
    // A dropped connection is not a dead link: keep the job retryable and, if
    // the machine is simply offline, say so instead of calling it a failure.
    const offline = !navigator.onLine;
    // Classify on the engine's own words, never on `message`: that one is
    // rewritten for the user and its prose can contain "network" or
    // "connection" innocently, which used to make a rate-limit look like the
    // Wi-Fi had dropped.
    job.netError = offline || isNetworkError(error);
    const st = card.querySelector('.job-state');
    st.textContent = job.netError ? (offline ? 'Waiting for internet…' : 'Connection lost') : 'Failed';
    st.className = job.netError ? 'job-state paused' : 'job-state error';
    card.querySelector('.speed').textContent = job.netError
      ? 'Will continue automatically when you are back online.'
      : message;
    const pauseBtn = card.querySelector('.pause-btn');
    const retryBtn = card.querySelector('.retry-btn');
    if (pauseBtn) pauseBtn.hidden = true;
    if (retryBtn) retryBtn.hidden = false;
    handleLog({ id, message: `Download failed: ${message}`, error: true });
    // A rate limit is a "not yet", not a "no". Wait it out and try again
    // instead of leaving a red card the user has to babysit.
    if (!job.netError && isRateLimited(error) && scheduleRateLimitRetry(id, job, card)) {
      card.classList.remove('error');
    }
  }
}

// Errors and log lines arrive straight from the download engine and name the
// tools and file paths behind it. Customers should never see the plumbing, so
// strip it on the way to the screen. The meaning of the message is kept.
// Some failures have a specific cause and a specific cure. Say those plainly
// instead of passing the engine's own wording through — which also mangles the
// help links it embeds, since the rename below rewrites them mid-URL.
const KNOWN_FAILURES = [
  {
    // Measured on two refused videos: every player client, a cookie jar, a JS
    // runtime and a full Chromium window all got the same refusal, while an
    // unrestricted video returned 2160p from the same address in the same
    // second. So this is YouTube refusing THIS video to an anonymous request,
    // not the connection being throttled — which is what the old wording said,
    // and it sent people off to wait for something that was never going to
    // clear.
    match: /sign in to confirm you.{0,3}re not a bot|confirm you.{0,3}re not a bot/i,
    message: 'YouTube has flagged this internet connection, so it is refusing this video. The same video downloads normally on another connection — a phone hotspot is the quickest test. A proxy in Settings does the same thing permanently. The flag is on the connection, not on you, and it clears on its own if the connection is left alone for a while.',
  },
  {
    match: /the page needs to be reloaded/i,
    message: 'YouTube rejected this request. Press Retry in a minute. If it keeps happening, this video needs a sign-in token Velox cannot produce yet.',
  },
  {
    match: /this video is not available/i,
    message: 'This video is not available in your region, or the uploader has restricted it.',
  },
  {
    match: /(private video|members[- ]only|join this channel)/i,
    message: 'This video is private or members-only. Sign in to an account that can view it in the Browser tab, then press Retry.',
  },
  {
    match: /requested format is not available/i,
    message: 'That quality is not offered for this video. Try Best, or a lower quality.',
  },
];

function cleanUserMessage(msg) {
  const raw = String(msg || '');
  const known = KNOWN_FAILURES.find((k) => k.match.test(raw));
  if (known) return known.message;

  return raw
    .replace(/^ERROR:\s*/i, '')
    .replace(/https?:\/\/\S+/g, '')     // strip engine help links before renaming
    .replace(/\byt[-_]?dlp(\.exe)?\b/gi, 'the download engine')
    .replace(/\bff(mpeg|probe)(\.exe)?\b/gi, 'the media converter')
    .replace(/\[(youtube|download|merger|extractaudio|videoremuxer|videoconvertor)[^\]]*\]\s*/gi, '')
    .replace(/^[\w-]{6,20}:\s*/, '')    // the bare video id left behind by that tag
    .trim();
}

// Tell "the network went away" apart from "this link is broken". An HTTP status
// means the server answered, so that is the link's problem, not the Wi-Fi's.
function isNetworkError(msg) {
  const m = String(msg || '');
  if (/HTTP Error \d{3}/i.test(m)) return false;
  return /connection|timed? ?out|timeout|network|getaddrinfo|name resolution|reset by peer|remote end closed|unreachable|refused|10054|10060|11001/i.test(m);
}

// YouTube rate-limits by IP, and it clears on its own after a few minutes. The
// old behaviour was to fail the job and print "wait a few minutes and press
// Retry" — asking the user to do by hand, at a time they have to guess, the one
// thing the app can do perfectly well itself.
function isRateLimited(msg) {
  const m = String(msg || '');
  // "Not a bot" is deliberately NOT here. It looks like a rate limit and was
  // treated as one, but it does not clear with time: it is YouTube refusing
  // that video to an anonymous request, and retrying for fifteen minutes only
  // delayed the message telling the user to sign in.
  return /HTTP Error 429|too many requests|the page needs to be reloaded/i.test(m);
}

// Back off further each time rather than hammering the limiter that is already
// refusing us: 1, 2, 4 then 8 minutes. Four attempts covers the ~15 minutes
// these blocks were measured to last, and the job stays retryable by hand after.
const RATE_LIMIT_WAITS_MS = [60000, 120000, 240000, 480000];
const rateLimitTimers = new Map();

function scheduleRateLimitRetry(id, job, card) {
  const attempt = job.rateLimitAttempt || 0;
  if (attempt >= RATE_LIMIT_WAITS_MS.length) return false;
  job.rateLimitAttempt = attempt + 1;
  const waitMs = RATE_LIMIT_WAITS_MS[attempt];

  const st = card.querySelector('.job-state');
  const speed = card.querySelector('.speed');
  const retryBtn = card.querySelector('.retry-btn');
  // Leave Retry available: a user who has just switched to a hotspot should not
  // have to wait out a timer that is now pointless.
  if (retryBtn) retryBtn.hidden = false;

  let left = Math.round(waitMs / 1000);
  const paint = () => {
    st.textContent = 'Waiting out YouTube';
    st.className = 'job-state paused';
    const mins = Math.floor(left / 60);
    const secs = left % 60;
    const when = mins ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
    speed.textContent = `YouTube is rate-limiting this connection. Trying again in ${when} (attempt ${job.rateLimitAttempt} of ${RATE_LIMIT_WAITS_MS.length}).`;
  };
  paint();

  const tick = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(tick); return; }
    paint();
  }, 1000);

  const timer = setTimeout(() => {
    clearInterval(tick);
    rateLimitTimers.delete(id);
    // The card can be gone by now (cancelled, or the app moved on).
    if (state.jobs.get(id) === job && document.getElementById(id)) retryJob(id);
  }, waitMs);

  rateLimitTimers.set(id, { timer, tick });
  return true;
}

function cancelRateLimitRetry(id) {
  const t = rateLimitTimers.get(id);
  if (!t) return;
  clearTimeout(t.timer);
  clearInterval(t.tick);
  rateLimitTimers.delete(id);
}

// Restart a failed job. yt-dlp resumes from the .part file already on disk, so
// this continues rather than starting the download over.
async function retryJob(id) {
  const job = state.jobs.get(id);
  if (!job) return;
  const card = document.getElementById(id);
  if (!card) return;
  // Whether the user pressed Retry or the backoff timer fired, only one attempt
  // should be in flight.
  cancelRateLimitRetry(id);
  card.classList.remove('error');
  const st = card.querySelector('.job-state');
  st.textContent = 'Reconnecting…';
  st.className = 'job-state';
  card.querySelector('.speed').textContent = '';
  card.querySelector('.retry-btn').hidden = true;
  const pauseBtn = card.querySelector('.pause-btn');
  if (pauseBtn) pauseBtn.hidden = false;
  setPauseLabel(card, 'Pause');
  job.state = 'downloading';
  job.netError = false;
  const ok = await window.api.resumeDownload(id);
  if (!ok) {
    handleDone({ id, ok: false, error: 'Could not continue this download — add the link again.' });
  }
}

// When the connection comes back, pick up every job that stopped because it went
// away. Nothing is re-downloaded; each one continues from where it stopped.
window.addEventListener('online', () => {
  const waiting = [...state.jobs.entries()].filter(([, j]) => j.state === 'error' && j.netError);
  if (!waiting.length) return;
  handleLog({ message: `Back online — continuing ${waiting.length} download${waiting.length > 1 ? 's' : ''}.` });
  waiting.forEach(([id]) => retryJob(id));
});

window.addEventListener('offline', () => {
  handleLog({ message: 'Connection lost. Downloads will continue when you are back online.', error: true });
});

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
    const resumed = await window.api.resumeDownload(id);
    if (!resumed) {
      handleDone({ id, ok: false, error: 'Could not resume download.' });
    }
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
  // Otherwise a pending backoff would resurrect a job the user just cancelled.
  cancelRateLimitRetry(id);
  // Drop it from the queue first: a job cancelled while waiting must never be
  // handed a slot later.
  const at = state.queue.indexOf(id);
  if (at !== -1) state.queue.splice(at, 1);
  await window.api.cancelDownload(id);
  const card = document.getElementById(id);
  if (card && card.parentElement) card.parentElement.removeChild(card);
  state.jobs.delete(id);
  updateStatus();
  pumpQueue();
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

  // The in-page Download button (renderer/browser-inject.js) talks back here.
  bv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'velox-page-links') {
      handlePageLinks((e.args && e.args[0]) || {});
      return;
    }
    if (e.channel !== 'velox-download') return;
    const d = (e.args && e.args[0]) || {};
    if (!d.url) return;
    // Same path the browser extension already uses, so quality, bitrate and
    // the source page are all handled in one place.
    handleBridgeDownload({ ...d, sourcePage: d.sourcePage || bv.getURL() });
  });

  const allBtn = document.getElementById('bvDownloadAll');
  if (allBtn) {
    allBtn.addEventListener('click', () => {
      if (!state.folder) { alert('Pick a save folder first.'); return; }
      allBtn.disabled = true;
      allBtn.textContent = 'SCANNING…';
      // The webview answers on the ipc-message channel above; if the page has
      // no injector (about:blank, a PDF) nothing comes back, so the button is
      // released on a timer either way.
      try { bv.send('velox-collect-links'); } catch { /* no injector on this page */ }
      setTimeout(() => { allBtn.disabled = false; allBtn.textContent = 'ALL ON PAGE'; }, 2500);
    });
  }

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

// The Browser tab used to load YouTube the moment the app started, which cost
// CPU and network before the user had asked for anything and made the first
// tab switch stutter. Load it on first visit instead.
let bvLoaded = false;
function ensureBrowserLoaded() {
  if (bvLoaded || !els.bv) return;
  bvLoaded = true;
  const home = els.bv.dataset.home || 'https://www.youtube.com';
  els.bv.loadURL(home).catch(() => {});
}

function bvNavigate(url) {
  if (!els.bv) return;
  bvLoaded = true;
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
  openTab('new');
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
  if (body) body.innerHTML = '<div class="modal-loading">Loading supported sites…</div>';
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
    hideLockScreen();
    renderLicenseProfile(status.profile || status);
  } else {
    renderLicenseProfile(null);
    if (status.message) {
      const sub = document.getElementById('lockSub');
      if (sub) sub.textContent = status.message;
    }
    await showLockScreen();
  }

  const showInvalidLicense = (detail = {}) => {
    const sub = document.getElementById('lockSub');
    if (sub) sub.textContent = detail.message || 'Your license is no longer active. Contact support or enter a new key.';
    renderLicenseProfile(null);
    showLockScreen();
  };

  if (window.api.onLicenseInvalidated) {
    window.api.onLicenseInvalidated(showInvalidLicense);
  } else {
    window.api.onLicenseRevoked(() => showInvalidLicense({ message: 'Your license was revoked. Contact support or enter a new key.' }));
  }
}

// The browser tab's <webview> runs in its own process and keeps keyboard focus
// there. While the lock screen is up its inputs would look focusable but stay
// dead, because every keystroke still went to the embedded page. Taking the
// webview out of the layout releases that focus; hideLockScreen puts it back.
function setBrowserViewActive(active) {
  const bv = document.getElementById('bv');
  if (!bv) return;
  bv.style.visibility = active ? '' : 'hidden';
  if (!active && typeof bv.blur === 'function') { try { bv.blur(); } catch {} }
}

function hideLockScreen() {
  const lock = document.getElementById('lockScreen');
  if (lock) lock.classList.add('hidden');
  setBrowserViewActive(true);
}

// Guard so repeated sign-out/sign-in cycles don't stack a fresh set of tab
// listeners on every call.
let lockTabsWired = false;

function showLockScreen() {
  return new Promise((resolve) => {
    const lock = document.getElementById('lockScreen');
    lock.classList.remove('hidden');
    setBrowserViewActive(false);

    const tabs = lock.querySelectorAll('[data-lk-mode]');
    const panes = lock.querySelectorAll('[data-lk-pane]');
    if (!lockTabsWired) {
      lockTabsWired = true;
      tabs.forEach((t) => t.addEventListener('click', () => {
        const m = t.dataset.lkMode;
        tabs.forEach((x) => x.classList.toggle('active', x === t));
        panes.forEach((p) => p.classList.toggle('hidden', p.dataset.lkPane !== m));
        // Put the caret in whichever field the chosen tab shows.
        const field = lock.querySelector(`[data-lk-pane="${m}"] input`);
        if (field) setTimeout(() => field.focus(), 0);
      }, { once: false }));
    }

    // Nothing focused the input before, so the caret never left the webview.
    setTimeout(() => {
      const visible = lock.querySelector('[data-lk-pane]:not(.hidden) input');
      if (visible) visible.focus();
    }, 60);

    const emailInput = document.getElementById('lkEmail');
    const emailInput2= document.getElementById('lkEmail2');
    const agreeBox   = document.getElementById('lkAgree');
    const emailBtn   = document.getElementById('lkEmailBtn');
    const emailMsg   = document.getElementById('lkEmailMsg');
    const keyInput   = document.getElementById('lkKey');
    const activateBtn= document.getElementById('lkActivateBtn');
    const keyMsg     = document.getElementById('lkKeyMsg');

    const setMsg = (el, text, cls) => {
      el.className = 'lock-msg' + (cls ? ' ' + cls : '');
      el.textContent = text;
    };

    // The button stays out of reach until both addresses match and the one-
    // machine rule has been read. It is a licence that cannot be moved: better
    // to slow this screen down than to hand someone a key for an address they
    // mistyped, on the only computer they will get.
    const emailsMatch = () => {
      const a = (emailInput.value || '').trim().toLowerCase();
      const b = (emailInput2.value || '').trim().toLowerCase();
      return a.length > 0 && a === b;
    };
    const refreshEmailGate = () => {
      const a = (emailInput.value || '').trim();
      const b = (emailInput2.value || '').trim();
      emailBtn.disabled = !(emailsMatch() && agreeBox.checked);
      if (a && b && !emailsMatch()) setMsg(emailMsg, 'The two addresses do not match.', 'error');
      else if (emailMsg.textContent === 'The two addresses do not match.') setMsg(emailMsg, '');
    };
    [emailInput, emailInput2].forEach((el) => {
      el.addEventListener('input', refreshEmailGate);
      // Pasting the same typo twice is not a confirmation, so the second box
      // does not take a paste.
      if (el === emailInput2) el.addEventListener('paste', (e) => {
        e.preventDefault();
        setMsg(emailMsg, 'Type the address again rather than pasting it.', 'error');
      });
    });
    agreeBox.addEventListener('change', refreshEmailGate);
    refreshEmailGate();

    emailBtn.onclick = async () => {
      const email = (emailInput.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setMsg(emailMsg, 'Enter a valid email.', 'error'); return;
      }
      if (!emailsMatch()) {
        setMsg(emailMsg, 'The two addresses do not match.', 'error'); return;
      }
      if (!agreeBox.checked) {
        setMsg(emailMsg, 'Please confirm you understand the one-computer rule.', 'error'); return;
      }
      // The last word before a licence is spent on this machine, naming the
      // address so a wrong one is still catchable here.
      if (!confirm(`Send the licence key to:\n\n${email}\n\nThis key will only ever work on this computer. Continue?`)) {
        return;
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
        renderLicenseProfile(a.profile || null);
        setMsg(emailMsg, 'Activated. Welcome!', 'success');
        setTimeout(() => {
          hideLockScreen();
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
        renderLicenseProfile(a.profile || null);
        setMsg(keyMsg, 'Activated. Welcome!', 'success');
        setTimeout(() => {
          hideLockScreen();
          resolve();
        }, 600);
      } else {
        setMsg(keyMsg, a.error || 'Activation failed.', 'error');
      }
    };
  });
}

async function signOutLicense() {
  if (!confirm('Sign out from this license?')) return;
  await window.api.licenseClear();
  renderLicenseProfile(null);
  const sub = document.getElementById('lockSub');
  if (sub) sub.textContent = 'You signed out. Enter your email or paste a license key to continue.';
  showLockScreen();
}

function renderLicenseProfile(profile) {
  if (!profile || !profile.key) {
    if (els.profileCard) els.profileCard.classList.add('hidden');
    if (els.statLicense) els.statLicense.textContent = '—';
    if (els.settingsLicenseProfile) els.settingsLicenseProfile.textContent = 'Not activated';
    if (els.settingsLicenseExpiry) els.settingsLicenseExpiry.textContent = '—';
    return;
  }

  const email = profile.email || 'Licensed user';
  const key = profile.key || '';
  const days = typeof profile.daysRemaining === 'number' ? profile.daysRemaining : null;
  const expiresAt = profile.expiresAt ? Number(profile.expiresAt) : null;
  const dayText = days === null ? 'Lifetime' : days === 1 ? '1 day left' : `${days} days left`;
  const expiryText = expiresAt ? new Date(expiresAt).toLocaleString() : 'Lifetime license';
  const initial = (email.trim()[0] || 'U').toUpperCase();

  if (els.profileCard) els.profileCard.classList.remove('hidden');
  if (els.profileAvatar) els.profileAvatar.textContent = initial;
  if (els.profileEmail) els.profileEmail.textContent = email;
  if (els.profileKey) els.profileKey.textContent = key;
  if (els.profileDays) els.profileDays.textContent = dayText;
  if (els.profileState) els.profileState.textContent = profile.status || 'Active';
  if (els.statLicense) els.statLicense.textContent = dayText;
  if (els.settingsLicenseProfile) els.settingsLicenseProfile.textContent = `${email} · ${key}`;
  if (els.settingsLicenseExpiry) els.settingsLicenseExpiry.textContent = expiryText;
  if (els.profileMeter) {
    const width = days === null ? 100 : Math.max(4, Math.min(100, (days / 30) * 100));
    els.profileMeter.style.width = `${width}%`;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }
