const { app, BrowserWindow, ipcMain, dialog, shell, net, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { checkBinaries: coreCheckBinaries, startDownload, resolveBinary } = require('./core/downloader');
const { probe, search: ytSearch, listExtractors, playlistEntries } = require('./core/extractor');
const torrentManager = require('./core/torrent-manager');
const fitGirlScraper = require('./core/scraper-fitgirl');
const one337xScraper = require('./core/scraper-1337x');
const softwareScraper = require('./core/scraper-software');
const searchEngine = require('./core/search-engine');
const siteSearch = require('./core/site-search');
const proxyStore = require('./core/proxy');
const { startDirectDownload } = require('./core/direct-download');
const ytPage = require('./core/yt-page-script');
const { autoUpdater } = require('electron-updater');
// Network guards for the device's own yt-dlp. Extraction wants to fail fast so a
// dead link doesn't hang the paste; a download wants the opposite — it should
// ride out a Wi-Fi drop rather than throw away a half-finished file.
const YTDLP_OPTS = {
  socketTimeout: parseInt(process.env.VELOX_SOCKET_TIMEOUT_SEC || '20', 10),
  maxRetries: parseInt(process.env.VELOX_DL_RETRIES || '2', 10),
  timeoutMs: parseInt(process.env.VELOX_EXTRACT_TIMEOUT_SEC || '60', 10) * 1000,
};

// Download-only guards. 30 retries at 5s apart survives ~2.5 minutes offline
// without the job ever failing; --continue (see buildArgs) means the retry picks
// up from the bytes already on disk.
const DOWNLOAD_OPTS = {
  socketTimeout: parseInt(process.env.VELOX_DL_SOCKET_TIMEOUT_SEC || '30', 10),
  maxRetries: parseInt(process.env.VELOX_DL_RETRIES_DOWNLOAD || '30', 10),
  retrySleep: parseInt(process.env.VELOX_DL_RETRY_SLEEP_SEC || '5', 10),
};

let mainWindow;
const BRIDGE_PORT = 47813;
const DAY_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MINUTES = Math.max(1, parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES || '5', 10));

// Where "Upgrade" sends people. Overridable so a test build can point at a
// staging site instead of taking a customer to the real checkout.
const STORE_URL = process.env.VELOX_STORE_URL || 'https://veloxdownloader.prolanka.online/';

// Windows names a notification after the app's user-model id, and Electron's
// default is its own — which is why every toast this app raised said
// "electron.app.Electron" instead of Velox Downloader. This has to match the
// appId in package.json's build config, because that is the id the installer
// writes into the Start Menu shortcut, and Windows only shows the friendly
// name when the two agree.
app.setAppUserModelId('com.prolanka.veloxdownloader');
app.setName('Velox Downloader');

// Ships pointing at the hosted license + extraction server. For local dev,
// override with the LICENSE_SERVER_URL env var (e.g. http://localhost:4000).
const LICENSE_SERVER_URL =
  (process.env.LICENSE_SERVER_URL || 'https://downloader.prolanka.online').replace(/\/+$/, '');
const LICENSE_BYPASS = process.env.LICENSE_BYPASS === '1';

const HISTORY_PATH = () => path.join(app.getPath('userData'), 'history.json');
const LICENSE_PATH = () => path.join(app.getPath('userData'), 'license.json');
const COOKIE_PATH = () => path.join(app.getPath('userData'), 'cookies.txt');
const YT_SIGNIN_PATH = () => path.join(app.getPath('userData'), 'yt-signin.json');
const SPEED_PATH = () => path.join(app.getPath('userData'), 'speed-limit.json');

// Download speed cap, in bytes per second. 0 means no cap.
let speedLimit = null;
function speedLimitBytes() {
  if (speedLimit === null) {
    try { speedLimit = Number(JSON.parse(fs.readFileSync(SPEED_PATH(), 'utf-8')).bytesPerSecond) || 0; }
    catch { speedLimit = 0; }
  }
  return speedLimit;
}
function setSpeedLimit(bytesPerSecond) {
  const n = Math.max(0, Math.floor(Number(bytesPerSecond) || 0));
  // Below about 16 KB/s a download makes no progress worth watching, and a
  // mistyped tiny number would look like a hang rather than a setting.
  speedLimit = n > 0 && n < 16 * 1024 ? 16 * 1024 : n;
  try { fs.writeFileSync(SPEED_PATH(), JSON.stringify({ bytesPerSecond: speedLimit })); } catch {}
  return speedLimit;
}

// Whether to hand the user's YouTube sign-in to the download engine. Off by
// default: signed-in cookies break some videos that work anonymously, so this
// is only worth turning on for the ones YouTube refuses outright.
let ytSignIn = null;
function ytSignInEnabled() {
  if (ytSignIn === null) {
    try { ytSignIn = !!JSON.parse(fs.readFileSync(YT_SIGNIN_PATH(), 'utf-8')).enabled; }
    catch { ytSignIn = false; }
  }
  return ytSignIn;
}
function setYtSignIn(on) {
  ytSignIn = !!on;
  try { fs.writeFileSync(YT_SIGNIN_PATH(), JSON.stringify({ enabled: ytSignIn }), { mode: 0o600 }); } catch {}
  return ytSignIn;
}

// ---------- cookies for the download engine ----------
//
// YouTube increasingly answers anonymous requests with "Sign in to confirm
// you're not a bot". yt-dlp's own --cookies-from-browser is unreliable on
// Windows (Chrome fails DPAPI decryption, Edge's database is locked), so we
// use the one cookie jar this app fully controls: the Browser tab's session.
// Sign in to a site there once and downloads from it are signed in too.
async function exportBrowserCookies() {
  try {
    const ses = session.fromPartition('persist:browser');
    const all = await ses.cookies.get({});

    // Google's own cookies are left out by default. Measured: a video that
    // resolves anonymously at 2160p fails with "The page needs to be reloaded"
    // the moment a signed-in Google cookie is attached, because the
    // authenticated web client then demands a proof-of-origin token we cannot
    // produce. Cookies still help everywhere else (private posts, members'
    // content), so only Google is dropped.
    //
    // But some videos are refused outright without a signed-in account:
    // measured on 7s1HX4Xso9M and kdJWDSf0hX0, where every player client, a
    // cookie jar, a JS runtime and even a full Chromium window all came back
    // "LOGIN_REQUIRED - Sign in to confirm you're not a bot", while an
    // unrestricted video returned 2160p in the same second. For those, the
    // sign-in is the only thing that helps, so it is offered as a setting the
    // user turns on rather than a default that would undo the fix above.
    const keepGoogle = String(process.env.VELOX_YT_COOKIES || '') === '1' || ytSignInEnabled();
    const cookies = keepGoogle
      ? all
      : all.filter((c) => !/(^|\.)(youtube\.com|google\.[a-z.]+|googlevideo\.com|ytimg\.com|youtu\.be)$/i.test(String(c.domain || '').replace(/^\./, '')));
    if (!cookies.length) return null;

    // Netscape cookies.txt: domain, subdomains, path, secure, expiry, name, value
    const lines = ['# Netscape HTTP Cookie File', '# Written by Velox from the Browser tab session.', ''];
    for (const c of cookies) {
      if (!c.name || c.value == null) continue;
      const subdomains = c.domain && c.domain.startsWith('.');
      lines.push([
        c.domain,
        subdomains ? 'TRUE' : 'FALSE',
        c.path || '/',
        c.secure ? 'TRUE' : 'FALSE',
        Math.floor(c.expirationDate || 0),
        c.name,
        c.value,
      ].join('\t'));
    }
    fs.writeFileSync(COOKIE_PATH(), lines.join('\n') + '\n');
    return COOKIE_PATH();
  } catch (e) {
    return null; // never let a cookie problem block a download
  }
}

// Refreshed before extraction and before every download so a fresh sign-in counts.
async function refreshCookiesForYtdlp() {
  if (process.env.VELOX_YTDLP_COOKIES) return; // an explicit file wins
  const file = await exportBrowserCookies();
  if (file) process.env.VELOX_YTDLP_COOKIES_AUTO = file;
}

// ---------- license helpers ----------

function readLicense() {
  try {
    if (!fs.existsSync(LICENSE_PATH())) return null;
    return JSON.parse(fs.readFileSync(LICENSE_PATH(), 'utf-8'));
  } catch { return null; }
}
function writeLicense(obj) {
  try {
    fs.mkdirSync(path.dirname(LICENSE_PATH()), { recursive: true });
    fs.writeFileSync(LICENSE_PATH(), JSON.stringify(obj, null, 2));
    return true;
  } catch { return false; }
}
function clearLicense() {
  try { fs.unlinkSync(LICENSE_PATH()); } catch {}
}

function normalizeLicenseKey(key) {
  return String(key || '').trim().toUpperCase().replace(/\s+/g, '');
}

function daysRemaining(expiresAt) {
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / DAY_MS));
}

function profileFromLicense(lic) {
  return {
    email: lic.email || '',
    key: lic.key || '',
    deviceId: lic.deviceId || '',
    expiresAt: lic.expiresAt || null,
    daysRemaining: daysRemaining(lic.expiresAt),
    status: lic.status || 'active',
    activatedAt: lic.activatedAt || null,
  };
}

function localExpiryResult(lic) {
  if (lic?.expiresAt && lic.expiresAt <= Date.now()) {
    clearLicense();
    return { licensed: false, reason: 'expired', message: 'Your license has expired.' };
  }
  return null;
}

function writeLicenseFromServer(existing, payload, fallbackKey, deviceIdValue) {
  const profile = payload.profile || {};
  const hasProfileEmail = Object.prototype.hasOwnProperty.call(profile, 'email');
  const hasProfileExpiry = Object.prototype.hasOwnProperty.call(profile, 'expiresAt');
  const hasBodyExpiry = Object.prototype.hasOwnProperty.call(payload, 'expiresAt');
  const next = {
    ...(existing || {}),
    key: normalizeLicenseKey(profile.key || payload.key || fallbackKey || existing?.key || ''),
    token: payload.token || existing?.token || '',
    email: hasProfileEmail ? (profile.email || '') : (payload.email || existing?.email || ''),
    deviceId: deviceIdValue || existing?.deviceId || '',
    expiresAt: hasProfileExpiry ? (profile.expiresAt || null) : hasBodyExpiry ? (payload.expiresAt || null) : (existing?.expiresAt || null),
    status: profile.status || existing?.status || 'active',
    activatedAt: existing?.activatedAt || Date.now(),
    lastVerifiedAt: Date.now(),
  };
  writeLicense(next);
  return next;
}

function deviceId() {
  const lic = readLicense();
  if (lic && lic.deviceId) return lic.deviceId;
  // Stable per-install hash of hostname + username + a random salt persisted in userData.
  const saltPath = path.join(app.getPath('userData'), '.device-salt');
  let salt = '';
  try {
    if (fs.existsSync(saltPath)) salt = fs.readFileSync(saltPath, 'utf-8');
    else {
      salt = crypto.randomBytes(16).toString('hex');
      fs.mkdirSync(path.dirname(saltPath), { recursive: true });
      fs.writeFileSync(saltPath, salt);
    }
  } catch {}
  return crypto
    .createHash('sha256')
    .update((os.hostname() || '') + '\n' + (os.userInfo().username || '') + '\n' + salt)
    .digest('hex')
    .slice(0, 32);
}
function deviceName() {
  return `${os.hostname()} (${os.platform()})`;
}

// A reply that isn't JSON means something in front of the app answered: a rate
// limiter sending plain text, a proxy error page, a captive portal. The user
// used to see the bare word "parse". Tell them what to do instead.
function humanHttpError(status, raw) {
  const text = String(raw || '').trim();
  if (status === 429 || /too many requests/i.test(text)) {
    return 'Too many attempts from this network. Please wait a few minutes and try again.';
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'The licence server is busy right now. Please try again in a moment.';
  }
  if (status >= 500) return 'The licence server had a problem. Please try again shortly.';
  if (!status) return 'No reply from the licence server. Check your internet connection.';
  return `Unexpected reply from the licence server (${status}).`;
}

function postJson(urlPath, body) {
  return new Promise((resolve) => {
    try {
      const req = net.request({
        method: 'POST',
        url: LICENSE_SERVER_URL + urlPath,
      });
      req.setHeader('Content-Type', 'application/json');
      let data = '';
      req.on('response', (res) => {
        res.on('data', (c) => (data += c.toString()));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
          catch { resolve({ status: res.statusCode, body: { ok: false, error: humanHttpError(res.statusCode, data) } }); }
        });
      });
      req.on('error', (e) => resolve({ status: 0, body: { ok: false, error: e.message } }));
      req.write(JSON.stringify(body || {}));
      req.end();
    } catch (e) {
      resolve({ status: 0, body: { ok: false, error: e.message } });
    }
  });
}

// Like postJson but attaches the license token — used for the gated
// /api/authorize pre-download check.
function postJsonAuth(urlPath, body, token) {
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: 'POST', url: LICENSE_SERVER_URL + urlPath });
      req.setHeader('Content-Type', 'application/json');
      if (token) req.setHeader('Authorization', `Bearer ${token}`);
      let data = '';
      req.on('response', (res) => {
        res.on('data', (c) => (data += c.toString()));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
          catch { resolve({ status: res.statusCode, body: { ok: false, error: humanHttpError(res.statusCode, data) } }); }
        });
      });
      req.on('error', (e) => resolve({ status: 0, body: { ok: false, error: e.message } }));
      req.write(JSON.stringify(body || {}));
      req.end();
    } catch (e) {
      resolve({ status: 0, body: { ok: false, error: e.message } });
    }
  });
}

async function licenseStatus() {
  if (LICENSE_BYPASS) return { licensed: true, bypass: true };
  let lic = readLicense();
  if (!lic || !lic.token) return { licensed: false, reason: 'no-license' };
  const expired = localExpiryResult(lic);
  if (expired) return expired;

  const pulse = await doHeartbeat();
  if (!pulse.ok && !pulse.transient) {
    return {
      licensed: false,
      reason: pulse.reason || 'license-invalid',
      message: pulse.message || pulse.error || 'License is not active.',
    };
  }
  lic = readLicense() || lic;
  return { licensed: true, profile: profileFromLicense(lic), transient: pulse.transient || false };
}

async function doSignup(email) {
  const r = await postJson('/api/signup', { email, deviceId: deviceId(), deviceName: deviceName() });
  if (r.status === 200 && r.body && r.body.ok) {
    return { ok: true, key: r.body.key, profile: r.body.profile || null, expiresAt: r.body.expiresAt || null };
  }
  if (r.status === 0) {
    return { ok: false, error: `Cannot reach license server at ${LICENSE_SERVER_URL}. Start the server or set LICENSE_SERVER_URL.` };
  }
  return { ok: false, error: r.body?.error || `signup failed (${r.status})` };
}

async function doActivate(key) {
  const normalizedKey = normalizeLicenseKey(key);
  if (!normalizedKey) return { ok: false, error: 'Enter a key.' };
  const did = deviceId();
  const r = await postJson('/api/activate', { key: normalizedKey, deviceId: did, deviceName: deviceName() });
  if (r.status === 200 && r.body?.ok) {
    const lic = writeLicenseFromServer(null, r.body, normalizedKey, did);
    absorbAccount(r.body, r.body.profile || null);
    return { ok: true, profile: profileFromLicense(lic) };
  }
  if (r.status === 0) {
    return { ok: false, error: `Cannot reach license server at ${LICENSE_SERVER_URL}. Start the server or set LICENSE_SERVER_URL.` };
  }
  return { ok: false, error: r.body?.error || `activate failed (${r.status})` };
}

async function doHeartbeat() {
  const lic = readLicense();
  if (!lic || !lic.token) return { ok: false, revoked: false, reason: 'no-license' };
  const expired = localExpiryResult(lic);
  if (expired) return { ok: false, revoked: false, expired: true, reason: 'expired', message: expired.message };
  const r = await postJson('/api/heartbeat', { token: lic.token });
  if (r.status === 200 && r.body?.ok) {
    const updated = writeLicenseFromServer(lic, r.body, lic.key, lic.deviceId);
    absorbAccount(r.body, r.body.profile || null);
    return { ok: true, revoked: false, profile: profileFromLicense(updated) };
  }
  if (r.status === 403 && (r.body?.revoked || r.body?.blocked || r.body?.expired)) {
    absorbAccount(r.body, null);
    clearLicense();
    const reason = r.body.revoked ? 'revoked' : r.body.blocked ? 'blocked' : 'expired';
    return { ok: false, revoked: !!r.body.revoked, blocked: !!r.body.blocked, expired: !!r.body.expired, reason, message: r.body.error || `license ${reason}` };
  }
  if (r.status === 401 || r.status === 409) {
    // token invalid or device mismatch — force re-activation
    clearLicense();
    return { ok: false, revoked: false, reason: 'token-invalid', message: 'Please activate again.' };
  }
  // transient (network down) — don't lock
  return { ok: true, revoked: false, transient: true };
}

// ---------- account: the plan, the usage, and what we broadcast ----------
//
// The heartbeat already runs on a timer, so a price or a message changed in the
// admin panel reaches a running app on its next beat — nobody has to restart
// anything. What arrives is kept here and on disk, so the Account screen has
// something to show the moment the window opens, before this run's first beat.

const ACCOUNT_PATH = () => path.join(app.getPath('userData'), 'account.json');

let account = { profile: null, plans: [], notices: [], dismissed: [], seen: [], updatedAt: 0 };

function loadAccount() {
  try {
    if (!fs.existsSync(ACCOUNT_PATH())) return;
    const saved = JSON.parse(fs.readFileSync(ACCOUNT_PATH(), 'utf-8'));
    account = {
      profile: saved.profile || null,
      plans: Array.isArray(saved.plans) ? saved.plans : [],
      notices: Array.isArray(saved.notices) ? saved.notices : [],
      dismissed: Array.isArray(saved.dismissed) ? saved.dismissed : [],
      seen: Array.isArray(saved.seen) ? saved.seen : [],
      updatedAt: saved.updatedAt || 0,
    };
  } catch {}
}

function saveAccount() {
  try {
    fs.mkdirSync(path.dirname(ACCOUNT_PATH()), { recursive: true });
    fs.writeFileSync(ACCOUNT_PATH(), JSON.stringify(account, null, 2));
  } catch {}
}

// A notice the customer has already closed stays closed, on this machine, for
// good — the list of ids is all that is kept, never the messages themselves.
function visibleNotices() {
  return account.notices.filter((n) => n && n.id && !account.dismissed.includes(n.id));
}

function accountInfo() {
  return {
    profile: account.profile,
    plans: account.plans,
    notices: visibleNotices(),
    storeUrl: STORE_URL,
    updatedAt: account.updatedAt,
  };
}

// Every server reply that carries plans/notices goes through here: the
// heartbeat, the activation, and the refusal an expired licence gets (which is
// the one person most worth showing an offer to).
function absorbAccount(body, profile) {
  if (!body) return;
  if (Array.isArray(body.plans)) account.plans = body.plans;
  if (Array.isArray(body.notices)) account.notices = body.notices;
  if (profile) account.profile = profile;
  account.updatedAt = Date.now();

  // Only ever raise a desktop notification for something this machine has not
  // been shown before, or every heartbeat would pop the same toast again.
  const unseen = visibleNotices().filter((n) => !account.seen.includes(n.id));
  account.seen = [...account.seen, ...unseen.map((n) => n.id)].slice(-200);
  account.dismissed = account.dismissed.slice(-200);
  saveAccount();

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('account-updated', accountInfo());
  for (const notice of unseen) showBroadcastNotice(notice);
}

function showBroadcastNotice(notice) {
  try {
    if (!Notification.isSupported()) return;
    const toast = new Notification({ title: notice.title || 'Velox Downloader', body: notice.body || '' });
    toast.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    toast.show();
  } catch {}
}

// Only ever an https address, and only ever in the real browser: a checkout
// page belongs in the browser the customer already trusts, not in a window
// this app draws.
function openStore(url) {
  const target = String(url || STORE_URL);
  if (!/^https:\/\//i.test(target)) return { ok: false, error: 'refused a link that is not https' };
  shell.openExternal(target);
  return { ok: true };
}

let heartbeatTimer = null;
function startHeartbeatLoop() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    const r = await doHeartbeat();
    if (!r.ok && !r.transient && mainWindow && !mainWindow.isDestroyed()) {
      notifyLicenseInvalidated(r);
    }
  }, HEARTBEAT_INTERVAL_MINUTES * 60 * 1000);
}

// Electron-specific bin/ location (packaged build keeps binaries under resources).
// The core downloader reads this through VELOX_BIN_DIR, set once in whenReady().
function electronBinDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, 'bin');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#cdd6f4',
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function startBridgeServer() {
  const allowedSchemes = ['chrome-extension://', 'moz-extension://', 'safari-web-extension://', 'edge-extension://'];

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const isExt = allowedSchemes.some((s) => origin.startsWith(s));

    if (isExt) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (origin && !isExt) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden origin' }));
      return;
    }

    if (req.url === '/ping' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'Velox Downloader', version: '2.1' }));
      return;
    }

    if (req.url === '/download' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (!payload.url) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing url' }));
            return;
          }
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('bridge-download', {
              url: String(payload.url),
              mode: payload.mode === 'audio' ? 'audio' : 'video',
              quality: payload.quality || '1080p',
              audioBitrate: payload.audioBitrate || '192',
              referer: typeof payload.referer === 'string' ? payload.referer : '',
              sourcePage: typeof payload.sourcePage === 'string' ? payload.sourcePage : '',
              detectedUrl: typeof payload.detectedUrl === 'string' ? payload.detectedUrl : '',
              title: typeof payload.title === 'string' ? payload.title : '',
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`[bridge] listening on http://127.0.0.1:${BRIDGE_PORT}`);
  });
  server.on('error', (e) => console.error('[bridge]', e.message));
}

// ---------------------------------------------------------------------------
// Auto-update. Installers and latest.yml are served from our own site (see the
// `publish` block in package.json); the licence server is deliberately not in
// the loop, so an update still lands if that host is busy.
//
// electron-updater verifies the sha512 in latest.yml before it will install
// anything, and the .blockmap next to the installer means a point release only
// pulls the bytes that actually changed rather than the whole 150 MB.
// ---------------------------------------------------------------------------
const UPDATE_CHECK_INTERVAL_MS = Math.max(15, parseInt(process.env.VELOX_UPDATE_INTERVAL_MIN || '360', 10)) * 60 * 1000;
let updateState = { status: 'idle', version: null, percent: 0, error: null };

function sendUpdate(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function setupAutoUpdater() {
  // A dev run has no update metadata to compare against, and electron-updater
  // throws rather than no-ops if you ask it to check anyway.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    updateState = { status: 'downloading', version: info.version, percent: 0, error: null };
    sendUpdate('update-available', { version: info.version, releaseDate: info.releaseDate });
  });
  autoUpdater.on('update-not-available', () => {
    updateState = { status: 'idle', version: null, percent: 0, error: null };
  });
  autoUpdater.on('download-progress', (p) => {
    updateState.percent = Math.round(p.percent || 0);
    sendUpdate('update-progress', { percent: updateState.percent, bytesPerSecond: p.bytesPerSecond });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState = { status: 'ready', version: info.version, percent: 100, error: null };
    sendUpdate('update-downloaded', { version: info.version });
  });
  autoUpdater.on('error', (err) => {
    // A failed check is not worth interrupting the user over — the next one in
    // six hours will try again, and the app is perfectly usable meanwhile.
    updateState = { status: 'error', version: null, percent: 0, error: String(err && err.message || err) };
    sendUpdate('update-error', { error: updateState.error });
  });

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), UPDATE_CHECK_INTERVAL_MS);
}

// One copy of the app per machine.
//
// Without this every launch started a whole second app sharing one userData
// folder: two cookie writers racing over the same cookies.txt, two heartbeat
// loops, two bridge servers fighting for port 47813, and — the reason this was
// found — twice the traffic at YouTube from one connection, which is what
// trips its bot check. Two instances were measured running here two days apart.
//
// The second launch hands its arguments to the first and exits, so clicking the
// icon again raises the existing window instead of cloning the app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  // Let the core downloader resolve bundled binaries in packaged builds.
  process.env.VELOX_BIN_DIR = electronBinDir();
  // Before the window exists: the renderer re-adds saved torrents as soon as
  // it loads, and they need their saved metadata and bitfields.
  torrentManager.setDataDir(app.getPath('userData'));
  loadAccount();
  createWindow();
  startBridgeServer();
  setupAutoUpdater();

  // Warm the Search tab's caches so the first site-picker click and the first
  // SoundCloud search don't pay for them.
  siteSearch.warmUp({ binDir: electronBinDir(), cacheDir: app.getPath('userData') });
  refreshCookiesForYtdlp();
  proxyStore.load(app.getPath('userData'));
  applyBrowserProxy();
  // Off the startup path: it only reads a directory listing, but there is no
  // reason to make the window wait for it.
  setTimeout(cleanOrphanedTempDirs, 4000);

  // Background heartbeat (every 30 min)
  startHeartbeatLoop();

  // Immediate heartbeat after window loads — if admin changed access, ask renderer to show lock
  // The renderer's own licence gate already beats on the server as it starts,
  // so a second heartbeat here was a duplicate ~950ms round trip on every
  // launch. The periodic heartbeat loop above keeps the licence honest.


  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Record how far every torrent got, so the next launch carries on from here
// without re-hashing what is already on disk.
app.on('before-quit', () => {
  try { torrentManager.saveAllResumeData(); } catch {}
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('default-download-folder', () => {
  return path.join(os.homedir(), 'Downloads');
});

ipcMain.handle('open-folder', async (_e, target) => {
  if (!target) return;
  if (fs.existsSync(target)) {
    if (fs.statSync(target).isDirectory()) shell.openPath(target);
    else shell.showItemInFolder(target);
  }
});

ipcMain.handle('open-external', async (_e, url) => {
  if (typeof url !== 'string') return;
  if (!/^https?:\/\//i.test(url)) return;
  shell.openExternal(url);
});

// Device-side: search + supported-sites run on THIS device's yt-dlp (residential
// IP), so YouTube etc. work. The server only validates the license.
ipcMain.handle('list-extractors', async () => {
  return listExtractors({ binDir: electronBinDir(), timeoutMs: 60000 });
});

ipcMain.handle('yt-search', async (_e, { query, limit }) => {
  return ytSearch(query, limit, { binDir: electronBinDir(), ...YTDLP_OPTS, proxy: proxyStore.proxyFor('https://www.youtube.com/') });
});

// The Search tab's site picker: the curated catalog plus every other extractor
// yt-dlp knows about, each tagged with how it can be searched.
ipcMain.handle('site-list', async () => {
  return siteSearch.listSites({ binDir: electronBinDir(), cacheDir: app.getPath('userData') });
});

// Search inside one site. Sites with an adapter return real results; the rest
// hand back a browseUrl for the renderer to open in the browser tab.
ipcMain.handle('site-search', async (_e, { siteId, query, limit, page, kind }) => {
  return siteSearch.searchSite(siteId, query, limit, { binDir: electronBinDir(), ...YTDLP_OPTS, proxy: proxyStore.proxyFor((siteSearch.getSite(siteId) || {}).home), kind }, page);
});

ipcMain.handle('read-clipboard', () => {
  const { clipboard } = require('electron');
  return clipboard.readText();
});

// Device does extraction + download itself, so it needs all three binaries.
ipcMain.handle('check-binaries', () => {
  const info = coreCheckBinaries(electronBinDir());
  info.clientReady = info.ytdlpExists && info.ffmpegExists && info.ffprobeExists;
  return info;
});

ipcMain.handle('fetch-info', async (_e, url) => {
  const info = await probe(String(url || ''), { binDir: electronBinDir(), ...YTDLP_OPTS, proxy: proxyStore.proxyFor(url) });
  if (!(info.ok && info.meta)) return { ok: false, error: info.error || 'could not read this link' };
  const m = info.meta;
  return { ok: true, title: m.title, uploader: m.uploader, duration: m.duration, thumbnail: m.thumbnail, isPlaylist: m.isPlaylist };
});

// renderer job id -> { handle, payload, sender, paused }
const clientJobs = new Map();

function stopActiveDownloads(reason) {
  for (const [id, cj] of clientJobs.entries()) {
    clientJobs.delete(id);
    try { cj.handle && cj.handle.cancel(); } catch {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-done', { id, ok: false, error: reason || 'License is not active.' });
    }
  }
  // Torrents live in WebTorrent, not in clientJobs, so they survived this loop
  // and kept downloading after a revoke.
  try { torrentManager.pauseAll(); } catch {}
}

function notifyLicenseInvalidated(result) {
  const message = result?.message || 'License is not active.';
  stopActiveDownloads(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('license-invalidated', { reason: result?.reason || 'license-invalid', message });
    mainWindow.webContents.send('license-revoked');
  }
}

async function requireActiveLicenseForWork() {
  if (LICENSE_BYPASS) return { ok: true };
  const r = await doHeartbeat();
  if (r.ok || r.transient) return { ok: true };
  notifyLicenseInvalidated(r);
  return { ok: false, error: r.message || 'License is not active.' };
}

// ---------- temp cleanup ----------
//
// yt-dlp.exe is a PyInstaller onefile bundle: every run unpacks about 4MB into
// a _MEI<pid> folder under TEMP and deletes it again on a clean exit. Velox
// kills that process routinely — pause, cancel, and the extraction timeout all
// do — and a killed process never gets to clean up.
//
// Measured on this machine: 247 orphaned folders totalling 1.03GB had built up
// over four days, and when the disk finally filled, every download failed with
// "Failed to extract Cryptodome...decompression resulted in return code -1"
// — which reads like a corrupt download and is really a full disk.
function cleanOrphanedTempDirs() {
  const tmp = os.tmpdir();
  // Old enough that nothing running now can own it. A live extraction is only
  // minutes old, and Windows would refuse the delete anyway.
  const cutoff = Date.now() - 30 * 60 * 1000;
  let removed = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!/^_MEI\d+$/.test(name)) continue;
      const dir = path.join(tmp, name);
      try {
        const st = fs.statSync(dir);
        if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
        for (const f of fs.readdirSync(dir)) {
          try { bytes += fs.statSync(path.join(dir, f)).size; } catch {}
        }
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {
        // In use, or not ours to delete. Leaving it is always safe.
      }
    }
  } catch {}
  if (removed) {
    console.log(`[velox] cleaned ${removed} orphaned yt-dlp temp folders (${(bytes / 1048576).toFixed(1)} MB)`);
  }
  return removed;
}

// ---------- proxy ----------
//
// A second exit IP for the download engine. YouTube rate-limits per IP, and
// when it trips the only workaround users had was to tether to a phone.
//
// Not a VPN: torrent peer traffic does not go through this (WebTorrent has no
// SOCKS support), so the settings UI says so rather than implying protection
// it cannot give.

// The Browser tab runs in its own session, so it needs telling separately.
function applyBrowserProxy() {
  try {
    const ses = session.fromPartition('persist:browser');
    const cfg = proxyStore.get();
    // Scope 'youtube' would need a PAC script to express; a bypass list is the
    // honest equivalent and is what Chromium understands natively.
    if (cfg.enabled && cfg.url) {
      ses.setProxy({ proxyRules: cfg.url, proxyBypassRules: '<local>' });
    } else {
      ses.setProxy({ mode: 'direct' });
    }
  } catch (e) {
    console.error('[proxy] browser session:', e.message);
  }
}

// Reports whether the Browser tab actually holds a Google sign-in, so the
// settings row can say "you are not signed in yet" instead of silently doing
// nothing when the toggle is turned on.
ipcMain.handle('yt-signin-get', async () => {
  let signedIn = false;
  try {
    const ses = session.fromPartition('persist:browser');
    const all = await ses.cookies.get({ domain: '.google.com' });
    signedIn = all.some((c) => /^(SID|__Secure-1PSID|APISID)$/.test(c.name));
  } catch {}
  return { enabled: ytSignInEnabled(), signedIn };
});

ipcMain.handle('yt-signin-set', async (_e, on) => {
  setYtSignIn(on);
  // Rewrite the jar straight away so the next download uses the new rule.
  delete process.env.VELOX_YTDLP_COOKIES_AUTO;
  await refreshCookiesForYtdlp();
  return { ok: true, enabled: ytSignInEnabled() };
});

ipcMain.handle('netflix-creds-get', async () => {
  try {
    const configPath = path.join(electronBinDir(), 'Netflix-DL', 'configs', 'config.py');
    const cookiesPath = path.join(electronBinDir(), 'Netflix-DL', 'configs', 'Cookies', 'cookies.txt');
    if (!fs.existsSync(configPath)) return {};
    const content = fs.readFileSync(configPath, 'utf8');
    
    // Extract from Config["NETFLIX"]
    const netflixBlock = content.split('Config["NETFLIX"]')[1] || '';
    const emailMatch = netflixBlock.match(/"email"\s*:\s*"([^"]*)"/);
    const passMatch = netflixBlock.match(/"password"\s*:\s*"([^"]*)"/);
    
    // Extract proxy from VPN.proxies
    const proxyMatch = content.match(/"proxies"\s*:\s*"([^"]*)"/);
    
    const cookiesContent = fs.existsSync(cookiesPath) ? fs.readFileSync(cookiesPath, 'utf8') : '';
    return {
      email: emailMatch ? emailMatch[1] : '',
      password: passMatch ? passMatch[1] : '',
      proxy: proxyMatch ? proxyMatch[1] : '',
      cookies: cookiesContent
    };
  } catch (e) {
    return {};
  }
});

ipcMain.handle('netflix-creds-set', async (_e, email, password, cookies, proxy) => {
  try {
    const configPath = path.join(electronBinDir(), 'Netflix-DL', 'configs', 'config.py');
    const cookiesDir = path.join(electronBinDir(), 'Netflix-DL', 'configs', 'Cookies');
    const cookiesPath = path.join(cookiesDir, 'cookies.txt');
    
    if (!fs.existsSync(configPath)) return { ok: false };
    let content = fs.readFileSync(configPath, 'utf8');
    
    // Replace email and password ONLY inside Config["NETFLIX"]
    const parts = content.split('Config["NETFLIX"]');
    if (parts.length === 2) {
      let netflixBlock = parts[1];
      netflixBlock = netflixBlock.replace(/"email"\s*:\s*"[^"]*"/, `"email": "${email}"`);
      netflixBlock = netflixBlock.replace(/"password"\s*:\s*"[^"]*"/, `"password": "${password}"`);
      content = parts[0] + 'Config["NETFLIX"]' + netflixBlock;
    }
    
    // Set proxy in VPN.proxies
    if (proxy) {
      content = content.replace(/"proxies"\s*:\s*(?:None|"[^"]*")/, `"proxies": "${proxy}"`);
    } else {
      content = content.replace(/"proxies"\s*:\s*(?:"[^"]*")/, `"proxies": None`);
    }
    
    fs.writeFileSync(configPath, content, 'utf8');
    
    if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir, { recursive: true });
    if (cookies) {
      let cookieText = cookies.trim();
      // Auto-convert JSON cookies to Netscape format
      if (cookieText.startsWith('[')) {
        try {
          const jsonCookies = JSON.parse(cookieText);
          const lines = ['# Netscape HTTP Cookie File', '# https://curl.haxx.se/rfc/cookie_spec.html', ''];
          for (const c of jsonCookies) {
            const domain = c.domain || '';
            const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
            const cookiePath = c.path || '/';
            const secure = c.secure ? 'TRUE' : 'FALSE';
            const expiry = c.expirationDate ? Math.round(c.expirationDate) : '0';
            const name = c.name || '';
            const value = c.value || '';
            lines.push(`${domain}\t${flag}\t${cookiePath}\t${secure}\t${expiry}\t${name}\t${value}`);
          }
          cookieText = lines.join('\n') + '\n';
        } catch (e) {
          // Not valid JSON, save as-is
        }
      }
      // Add Netscape header if missing
      if (!cookieText.startsWith('# Netscape') && !cookieText.startsWith('#HttpOnly') && !cookieText.startsWith('.')) {
        cookieText = '# Netscape HTTP Cookie File\n' + cookieText;
      }
      fs.writeFileSync(cookiesPath, cookieText, 'utf8');
    }
    
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
});

ipcMain.handle('proxy-find-best', async (_e) => {
  const axios = require('axios');
  try {
    const res = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=US,GB&ssl=yes&anonymity=all');
    let proxies = res.data.split('\n').map(p => p.trim()).filter(p => p);
    // Shuffle and pick top 30 to test
    proxies.sort(() => 0.5 - Math.random());
    proxies = proxies.slice(0, 30);

    let bestProxy = null;
    let bestTime = Infinity;

    // Test them concurrently
    const tests = proxies.map(async (p) => {
      const [host, portStr] = p.split(':');
      const port = parseInt(portStr, 10);
      const start = Date.now();
      try {
        const testRes = await axios.get('https://www.netflix.com/', {
          proxy: { host, port, protocol: 'http' },
          timeout: 8000,
          validateStatus: (status) => status === 200 || status === 301 || status === 302
        });
        const latency = Date.now() - start;
        if (latency < bestTime) {
          bestTime = latency;
          bestProxy = 'http://' + p;
        }
      } catch (err) {
        // failed
      }
    });

    await Promise.all(tests);
    
    if (bestProxy) {
      return { ok: true, proxy: bestProxy, latency: bestTime };
    } else {
      return { ok: false, error: 'All tested proxies were dead or too slow.' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('proxy-get', () => proxyStore.get());

ipcMain.handle('proxy-set', (_e, patch) => {
  const res = proxyStore.set(patch || {});
  if (res.ok) applyBrowserProxy();
  return res;
});

// Prove the proxy actually carries traffic before the user trusts it, and show
// which IP the outside world now sees. Uses yt-dlp itself so the test exercises
// the same binary and the same flag the downloads will use.
ipcMain.handle('proxy-test', async (_e, url) => {
  const candidate = String(url || proxyStore.get().url || '').trim();
  const parsed = proxyStore.parse(candidate);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const direct = await publicIp([]);
  const viaProxy = await publicIp(['--proxy', parsed.url]);
  if (!viaProxy.ok) return { ok: false, error: viaProxy.error || 'Could not reach the proxy.' };
  // Reaching the proxy is not the same as gaining anything from it: a proxy on
  // this machine that is not itself tunnelled leaves the exit IP unchanged, and
  // so would not lift a YouTube block.
  if (direct.ok && direct.ip === viaProxy.ip) {
    return { ok: false, error: `The proxy works, but sites still see the same IP (${direct.ip}), so it will not get past a block on your connection.` };
  }
  return { ok: true, ip: viaProxy.ip, directIp: direct.ok ? direct.ip : null };
});

// Ask api.ipify.org who we look like, optionally through a proxy.
function publicIp(extraArgs) {
  return new Promise((resolve) => {
    const bin = resolveBinary('yt-dlp', electronBinDir());
    const { execFile } = require('child_process');
    // `-o -` writes the body to stdout. --dump-pages looks like the obvious
    // flag here but prints nothing and saves the response to a file in the
    // working directory instead, which left junk next to the executable.
    const args = [...extraArgs, '--socket-timeout', '15', '--quiet', '--no-warnings', '-o', '-', 'https://api.ipify.org'];
    execFile(bin, args, { timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const m = String(stdout || '').trim().match(/^((?:\d{1,3}\.){3}\d{1,3})$/);
      if (m) return resolve({ ok: true, ip: m[1] });
      // yt-dlp's proxy failures are a paragraph of nested Python exceptions
      // ending in "please report this issue on github", which is useless and
      // alarming to show a user. Recognise the common causes and say what to do.
      const raw = String(stderr || (err && err.message) || 'no answer');
      let why;
      if (/Unable to connect to proxy|actively refused|ProxyError/i.test(raw)) {
        why = 'Nothing is listening at that address. Check the host and port.';
      } else if (/timed out|timeout/i.test(raw)) {
        why = 'The proxy did not answer in time. It may be down or too slow to use.';
      } else if (/407|authentication|auth/i.test(raw)) {
        why = 'The proxy needs a username and password: socks5://user:pass@host:port';
      } else {
        why = raw.split(/\r?\n/)[0].replace(/^ERROR:\s*/, '').slice(0, 160);
      }
      resolve({ ok: false, error: why });
    });
  });
}

// ---------- device-side model: THIS device extracts + downloads with its own
// yt-dlp (residential IP → YouTube works); the server only gates the license. ----

// Probe a URL locally → metadata + the option menu the renderer shows.
// What a playlist or channel link actually contains. Answered before anything
// is queued, so the user picks from a real list rather than guessing.
ipcMain.handle('playlist-info', async (_e, { url, limit } = {}) => {
  const target = String(url || '');
  const res = await playlistEntries(target, {
    binDir: electronBinDir(),
    ...YTDLP_OPTS,
    limit,
    proxy: proxyStore.proxyFor(target),
  });
  return res;
});

ipcMain.handle('client-extract', async (_e, url) => {
  await refreshCookiesForYtdlp();
  const info = await probe(String(url || ''), { binDir: electronBinDir(), ...YTDLP_OPTS, proxy: proxyStore.proxyFor(url) });
  return info.ok ? info : { ok: false, error: info.error || 'could not read this link' };
});

// Get the server's go-ahead before a download: it validates the license
// (blocked/revoked/expired) and spends one device-locked trial credit. A cracked
// client that skips this loses block/revoke/trial enforcement — the documented
// deterrent trade-off of shipping the extractor on the device.
async function authorizeDownload() {
  if (LICENSE_BYPASS) return { ok: true };
  const lic = readLicense();
  const r = await postJsonAuth('/api/authorize', {}, lic && lic.token);
  if (r.status === 0) return { ok: false, error: `Cannot reach license server at ${LICENSE_SERVER_URL}.` };
  if (r.status === 401 || r.status === 403 || r.status === 409) {
    notifyLicenseInvalidated({ reason: r.body?.trialExpired ? 'trial-expired' : 'license-invalid', message: r.body?.error || 'License is not active.' });
    return { ok: false, error: r.body?.error || 'License is not active.' };
  }
  if (!(r.status === 200 && r.body && r.body.ok)) return { ok: false, error: r.body?.error || 'not authorized' };
  return { ok: true };
}

// Full local yt-dlp download (YouTube/HLS/merge/convert) straight to the user's
// folder. Progress/log/done are forwarded to the renderer over IPC.
// ---------- reading streams out of the signed-in browser session ----------
//
// yt-dlp asks YouTube from outside, as an anonymous client, and some videos are
// simply refused that way. This asks from inside a real youtube.com page in the
// Browser tab's session, so the request carries whatever sign-in the user
// already has there. Measured on a video nine yt-dlp clients could not touch:
// 35 formats up to 2160p came back with ordinary https URLs.

const YT_ID = /(?:v=|\/shorts\/|youtu\.be\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/;

function youtubeVideoId(url) {
  const m = String(url || '').match(YT_ID);
  return m ? m[1] : '';
}

// A hidden window on the Browser tab's own partition. It is closed as soon as
// the answer is read; nothing is left running.
async function browserExtract(videoId, timeoutMs = 45000) {
  let win = null;
  try {
    // Rendered, but parked off-screen. A show:false window was measured
    // failing where a visible one had just succeeded, so the page is given a
    // real compositor rather than being hidden outright. (That single
    // comparison is not conclusive - YouTube began refusing this route during
    // the same session - but a rendered window is the safer of the two.)
    win = new BrowserWindow({
      show: true,
      x: -32000,
      y: -32000,
      width: 1280,
      height: 800,
      skipTaskbar: true,
      focusable: false,
      webPreferences: { partition: 'persist:browser', backgroundThrottling: false },
    });
    const load = win.loadURL('https://www.youtube.com/watch?v=' + encodeURIComponent(videoId));
    await Promise.race([
      load,
      new Promise((_, rej) => setTimeout(() => rej(new Error('page timed out')), timeoutMs)),
    ]);
    // ytcfg is written by the page's own bootstrap; without it there is no API
    // key to call, so wait for it rather than firing a request that cannot work.
    const ready = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 40; i++) {
        if (window.ytcfg && window.ytcfg.data_ && window.ytcfg.data_.INNERTUBE_API_KEY) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })()`);
    if (!ready) return { ok: false, error: 'youtube-page-not-ready' };
    // The page's own bot-guard work is not finished the moment ytcfg appears,
    // and asking too early was measured returning the refusal that asking a
    // few seconds later did not.
    await new Promise((r) => setTimeout(r, 6000));
    return await win.webContents.executeJavaScript(ytPage.build(videoId));
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'browser extract failed' };
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
  }
}

// Only worth trying when YouTube refused the anonymous request. Anything else
// (a dead link, no disk space) would fail the same way a second time.
function isYouTubeJob(payload) {
  return !!youtubeVideoId(payload && payload.url);
}

function refusedAnonymously(error) {
  return /confirm you.{0,3}re not a bot|sign in to confirm|LOGIN_REQUIRED|age.?restrict|inappropriate for some users/i
    .test(String(error || ''));
}

// The extraction worked and the media fetch was turned away — "unable to
// download video data: HTTP Error 403". It is still this connection being
// refused, so it belongs in the same rescue ladder (proxy, then the signed-in
// browser session). Until this it matched nothing and the download just died
// with a red card and no retry offered.
function refusedTheData(error) {
  return /unable to download video data|HTTP Error 403|\b403 Forbidden\b/i.test(String(error || ''));
}

// Downloads go over IPv4 (see ipStackArgs in core/downloader.js), which is
// wrong for a network that has no IPv4 route at all. That failure looks like a
// dead socket rather than a refusal, so it gets one attempt back over IPv6.
function noIpv4Route(error) {
  return /unreachable|WinError 1005[13]|Errno 101\b|Errno 10051|Cannot assign requested address/i
    .test(String(error || ''));
}

async function tryBrowserFallback(id, payload, sender, send) {
  const videoId = youtubeVideoId(payload && payload.url);
  if (!videoId) return false;

  send('download-log', { message: 'YouTube refused that as an anonymous request. Trying your signed-in session…' });
  const info = await browserExtract(videoId);
  if (!info.ok || !info.formats || !info.formats.length) {
    send('download-log', { message: 'Your signed-in session could not read it either.', error: true });
    return false;
  }

  const picked = ytPage.choose(info.formats, { quality: payload.quality, mode: payload.mode });
  if (!picked) return false;

  const handle = startDirectDownload({
    videoId,
    title: info.title || videoId,
    client: info.client,
    folder: payload.folder,
    mode: payload.mode,
    aFormat: payload.aFormat,
    video: picked.video,
    audio: picked.audio,
  }, { binDir: electronBinDir() });

  const cj = clientJobs.get(id);
  if (cj) { cj.handle = handle; cj.failed = false; }
  else clientJobs.set(id, { handle, payload, sender, paused: false, failed: false });

  handle.on('progress', (d) => send('download-progress', d));
  handle.on('log', (d) => send('download-log', d));
  handle.on('done', (d) => {
    if (d.cancelled) { clientJobs.delete(id); return; }
    if (d.ok) {
      clientJobs.delete(id);
      send('download-done', { ok: true, file: d.file, percent: 100 });
      return;
    }
    const j = clientJobs.get(id);
    if (j) { j.handle = null; j.failed = true; }
    send('download-done', { ok: false, error: d.error || 'download failed', resumable: !!j });
  });
  return true;
}

function startLocalDownload(id, payload, sender) {
  const send = (channel, data) => { if (sender && !sender.isDestroyed()) sender.send(channel, { id, ...data }); };
  const handle = startDownload({
    ...DOWNLOAD_OPTS,
    ...payload,
    // __forceProxy is set by the retry above; otherwise the scope decides.
    proxy: payload.__forceProxy || proxyStore.proxyFor(payload && payload.url),
    // Read per job, so changing the cap applies to the next download without
    // a restart. yt-dlp takes a plain byte count.
    limitRate: speedLimitBytes() || undefined,
  }, { binDir: electronBinDir() });
  clientJobs.set(id, { handle, payload, sender, paused: false, failed: false });

  handle.on('progress', (d) => send('download-progress', { percent: d.percent, size: d.size, speed: d.speed, eta: d.eta }));
  handle.on('log', (d) => send('download-log', { message: d.message, error: d.error }));
  handle.on('done', (d) => {
    if (d.cancelled) { clientJobs.delete(id); return; } // paused/cancelled — UI already handled
    if (d.ok) {
      clientJobs.delete(id);
      send('download-done', { ok: true, file: d.file, percent: 100 });
      return;
    }
    // YouTube refusing an anonymous request is not a dead link. Measured: the
    // same video that this connection is refused fetches normally from a phone
    // hotspot, and from a proxy, because the flag is on the address. So retry
    // through the proxy first, and only then ask the browser session.
    // Cheapest rescue first: re-run with the JS runtime. It is off by default
    // because it costs about ten seconds and usually changes nothing, but a
    // failed extraction is exactly the case where it might.
    if (!d.ok && !payload.allowIpv6 && isYouTubeJob(payload) && noIpv4Route(d.error)) {
      send('download-log', { message: 'No IPv4 route on this network — retrying over IPv6…' });
      const cj6 = clientJobs.get(id);
      if (cj6) { cj6.handle = null; }
      startLocalDownload(id, { ...payload, allowIpv6: true }, sender);
      return;
    }
    if (!d.ok && !payload.jsRuntime && !payload.__triedProxy && isYouTubeJob(payload)) {
      send('download-log', { message: 'Retrying with the JavaScript engine…' });
      const cj0 = clientJobs.get(id);
      if (cj0) { cj0.handle = null; }
      startLocalDownload(id, { ...payload, jsRuntime: true }, sender);
      return;
    }
    if ((refusedAnonymously(d.error) || refusedTheData(d.error)) && !payload.__triedProxy) {
      const rescue = proxyStore.rescueProxyFor(payload && payload.url);
      if (rescue) {
        send('download-log', { message: 'YouTube refused this connection. Retrying through your proxy…' });
        const cj0 = clientJobs.get(id);
        if (cj0) { cj0.handle = null; }
        startLocalDownload(id, { ...payload, __triedProxy: true, __forceProxy: rescue }, sender);
        return;
      }
    }
    if (refusedAnonymously(d.error) || refusedTheData(d.error)) {
      tryBrowserFallback(id, payload, sender, send).then((handled) => {
        if (handled) return;
        const j = clientJobs.get(id);
        if (j) { j.handle = null; j.failed = true; }
        send('download-done', { ok: false, error: d.error || 'download failed', resumable: !!j });
      });
      return;
    }
    // Keep the job registered so Retry (and auto-retry when the network comes
    // back) can restart it. yt-dlp's --continue resumes from the .part file, so
    // nothing already downloaded is lost.
    const cj = clientJobs.get(id);
    if (cj) { cj.handle = null; cj.failed = true; }
    send('download-done', { ok: false, error: d.error || 'download failed', resumable: !!cj });
  });
  return { ok: true };
}

// The renderer raises a gate the user cannot dismiss, but the renderer is not
// where enforcement belongs: a modified copy of it would simply not draw the
// gate. Refusing the work here is what actually makes the update mandatory.
function updateRequired() {
  return updateState && (updateState.status === 'downloading' || updateState.status === 'ready');
}

const UPDATE_REQUIRED_MESSAGE =
  'Velox is updating itself and has to finish before downloads can start again.';

ipcMain.handle('client-download', async (event, payload) => {
  if (updateRequired()) return { ok: false, error: UPDATE_REQUIRED_MESSAGE };
  const auth = await authorizeDownload();
  if (!auth.ok) return auth;
  return startLocalDownload(payload.id, payload, event.sender);
});

// Pause: silently stop the device download; keep the config so resume can restart.
ipcMain.handle('pause-download', async (_e, id) => {
  const cj = clientJobs.get(id);
  if (!cj) return false;
  try { cj.handle && cj.handle.killSilently(); } catch {}
  cj.paused = true;
  return true;
});

// Resume / retry: restart yt-dlp for the same renderer id. Used by the Pause
// button, by the Retry button on a failed card, and by the automatic retry when
// the network comes back. yt-dlp's --continue means it carries on from the
// bytes already on disk rather than starting the file over.
// Only re-checks the license (heartbeat) — it does NOT spend another trial credit.
ipcMain.handle('resume-download', async (event, id) => {
  const license = await requireActiveLicenseForWork();
  if (!license.ok) return false;
  const cj = clientJobs.get(id);
  if (!cj) return false;
  cj.paused = false;
  cj.failed = false;
  const r = startLocalDownload(id, cj.payload, event.sender);
  return !!r.ok;
});

ipcMain.handle('cancel-download', async (_e, id) => {
  const cj = clientJobs.get(id);
  if (cj) {
    try { cj.handle && cj.handle.cancel(); } catch {}
    clientJobs.delete(id);
  }
  return true;
});

ipcMain.handle('history-load', () => {
  try {
    if (!fs.existsSync(HISTORY_PATH())) return [];
    return JSON.parse(fs.readFileSync(HISTORY_PATH(), 'utf-8'));
  } catch {
    return [];
  }
});

ipcMain.handle('history-save', (_e, list) => {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH()), { recursive: true });
    fs.writeFileSync(HISTORY_PATH(), JSON.stringify(list, null, 2));
    return true;
  } catch {
    return false;
  }
});

// ---------- license IPC ----------

ipcMain.handle('license-status',   () => licenseStatus());
ipcMain.handle('license-signup',   (_e, email) => doSignup(String(email || '').trim()));
ipcMain.handle('license-activate', (_e, key)   => doActivate(String(key || '').trim()));
ipcMain.handle('license-clear',    () => {
  clearLicense();
  stopActiveDownloads('Signed out.');
  return { ok: true };
});
ipcMain.handle('license-heartbeat',() => doHeartbeat());

// ---------- account screen ----------
ipcMain.handle('account-info', () => accountInfo());

// A dismissal is remembered so the same banner does not come back on the next
// heartbeat, which would make the app feel broken.
ipcMain.handle('notice-dismiss', (_e, id) => {
  const noticeId = String(id || '');
  if (!noticeId) return { ok: false };
  if (!account.dismissed.includes(noticeId)) {
    account.dismissed = [...account.dismissed, noticeId].slice(-200);
    saveAccount();
  }
  return { ok: true, notices: visibleNotices() };
});

ipcMain.handle('open-store', (_e, url) => openStore(url));

// Asking the server now, rather than waiting for the next beat. The Account
// screen calls this when it opens so the numbers on it are today's.
ipcMain.handle('account-refresh', async () => {
  await doHeartbeat();
  return accountInfo();
});

// Update controls. The download happens on its own; these let the renderer show
// where it got to and let the user take the restart at a moment that suits them.
// Taskbar progress. Windows draws it into the taskbar icon itself, so the user
// can see how a download is going without raising the window. The renderer owns
// the whole picture - running jobs, queued jobs, failures - so it reports the
// figure rather than main guessing from its own job map.
ipcMain.handle('taskbar-progress', (_e, fraction) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const n = Number(fraction);
  // -1 removes the bar. Anything else is clamped: out-of-range values make
  // Windows draw a full bar, which would read as "finished".
  mainWindow.setProgressBar(Number.isFinite(n) && n >= 0 ? Math.min(1, n) : -1);
  return true;
});

ipcMain.handle('speed-limit-get', () => ({ bytesPerSecond: speedLimitBytes() }));
ipcMain.handle('speed-limit-set', (_e, bps) => ({ bytesPerSecond: setSpeedLimit(bps) }));
ipcMain.handle('app-version',    () => app.getVersion());
ipcMain.handle('update-status',  () => updateState);
ipcMain.handle('update-check',   async () => {
  if (!app.isPackaged) return { ok: false, reason: 'not-packaged' };
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
});
ipcMain.handle('update-install', () => {
  if (updateState.status !== 'ready') return { ok: false, reason: 'no-update-ready' };
  // setImmediate so the IPC reply reaches the renderer before the app goes down.
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
});

ipcMain.handle('window-control', (_e, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
});

// ---------- New Premium Features IPC ----------

// Torrents are downloads too, so they go through the same licence gate as
// yt-dlp jobs. Until this existed a trial key could pull unlimited torrents:
// the free-download counter only moved on /api/authorize, which lived in
// client-download and nothing here ever called.
//
// Adding a torrent only fetches its file list — nothing downloads until the
// user has picked files — so torrent-add needs an active licence but spends
// no credit. The credit goes in torrent-start, the first time files are
// confirmed. A restart re-adds torrents already confirmed, so it never
// charges for them again (same rule as resume-download).
function torrentEvents() {
  const send = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  };
  return {
    onProgress: (prog) => send('torrent-progress', prog),
    onFiles: (info) => send('torrent-files-ready', info),
    onDone: (id, infoHash, name) => send('torrent-done', { id, infoHash, name }),
    onError: (id, err) => send('torrent-error', { id, error: err.message }),
  };
}

ipcMain.handle('torrent-add', async (_e, { id, torrentId, hash, savePath, selected, confirmed, paused }) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Invalid torrent.' };
  if (updateRequired()) return { ok: false, error: UPDATE_REQUIRED_MESSAGE };
  const license = await requireActiveLicenseForWork();
  if (!license.ok) return { ok: false, error: license.error || 'License is not active.' };
  try {
    await torrentManager.add({
      id,
      source: torrentId || id,
      hash,
      savePath: savePath || path.join(os.homedir(), 'Downloads'),
      selected: Array.isArray(selected) ? selected : null,
      confirmed: !!confirmed,
      paused: !!paused,
    }, torrentEvents());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// The file picker's answer. The first time it spends the credit and starts
// the download; after that (the row's Files button) it only changes which
// files are fetched, for free.
ipcMain.handle('torrent-start', async (_e, { id, selected }) => {
  if (updateRequired()) return { ok: false, error: UPDATE_REQUIRED_MESSAGE };
  if (!torrentManager.getFiles(id)) return { ok: false, error: 'This torrent is not running any more.' };
  if (Array.isArray(selected) && !selected.length) return { ok: false, error: 'Choose at least one file.' };
  const auth = torrentManager.isConfirmed(id) ? await requireActiveLicenseForWork() : await authorizeDownload();
  if (!auth.ok) return { ok: false, error: auth.error || 'License is not active.' };
  try {
    torrentManager.setFiles(id, selected);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('torrent-get-files', (_e, id) => torrentManager.getFiles(id));

ipcMain.handle('torrent-pause', (_e, id) => {
  torrentManager.pause(id);
  return { ok: true };
});

// Re-checks the licence but spends no credit: the credit went when the files
// were first chosen. `notLoaded` means it is not running this session (its
// restore was refused, or it failed) and the renderer should add it back.
ipcMain.handle('torrent-resume', async (_e, id) => {
  if (!torrentManager.has(id)) return { ok: false, notLoaded: true };
  const license = await requireActiveLicenseForWork();
  if (!license.ok) return { ok: false, error: license.error || 'License is not active.' };
  torrentManager.resume(id);
  return { ok: true };
});

ipcMain.handle('torrent-remove', (_e, { id, destroyStore }) => {
  torrentManager.remove(id, destroyStore);
  return { ok: true };
});

ipcMain.handle('select-save-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('open-torrent-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Torrents', extensions: ['torrent'] }]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('open-external-folder', async (_e, folderPath) => {
  if (fs.existsSync(folderPath)) {
    await shell.openPath(folderPath);
    return true;
  }
  return false;
});



// Merge utility
function mergeArrays(arr1, arr2) {
  const merged = [];
  const max = Math.max(arr1.length, arr2.length);
  for (let i = 0; i < max; i++) {
    if (arr1[i]) merged.push(arr1[i]);
    if (arr2[i]) merged.push(arr2[i]);
  }
  return merged;
}

// IPC Handlers for game scrapers

ipcMain.handle('fitgirl-fetch', async () => {
  const [fg, x1337] = await Promise.all([
    fitGirlScraper.fetchLatest(),
    one337xScraper.searchGames('')
  ]);
  return mergeArrays(fg, x1337);
});

ipcMain.handle('fitgirl-search', async (_e, query) => {
  const [fg, x1337] = await Promise.all([
    fitGirlScraper.searchGames(query),
    one337xScraper.searchGames(query)
  ]);
  return mergeArrays(fg, x1337);
});

ipcMain.handle('fitgirl-get-magnet', async (_e, url) => {
  if (url.includes('1337x')) return await one337xScraper.getMagnetLink(url);
  return await fitGirlScraper.getMagnetLink(url);
});

ipcMain.handle('fitgirl-get-info', async (_e, url) => {
  if (url.includes('1337x')) return await one337xScraper.getGameInfo(url);
  return await fitGirlScraper.getGameInfo(url);
});

ipcMain.handle('search-global', async (_e, query) => {
  const data = await searchEngine.searchTorrents(query);
  return data;
});

ipcMain.handle('software-fetch', async () => {
  return await softwareScraper.fetchLatest();
});

ipcMain.handle('software-search', async (_e, query) => {
  return await softwareScraper.searchSoftware(query);
});

ipcMain.handle('search-duckduckgo', async (_e, { query, site }) => {
  try {
    const axios = require('axios');
    const cheerio = require('cheerio');
    let q = query;
    if (site && site !== 'Auto Detect' && site !== 'Torrents (Global)' && site !== 'YouTube') {
      const domainMap = {
        'Pornhub': 'pornhub.com',
        'XVideos': 'xvideos.com',
        'XNXX': 'xnxx.com',
        'Facebook': 'facebook.com',
        'Instagram': 'instagram.com',
        'TikTok': 'tiktok.com',
        'Twitter / X': 'twitter.com',
        'RedTube': 'redtube.com',
        'Vimeo': 'vimeo.com',
        'Dailymotion': 'dailymotion.com',
        'Soundcloud': 'soundcloud.com',
        'Twitch': 'twitch.tv',
        'Bilibili': 'bilibili.com'
      };
      if (domainMap[site]) {
        q = `site:${domainMap[site]} ${query}`;
      } else {
        q = `${site} ${query}`;
      }
    }
    
    const response = await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    const $ = cheerio.load(response.data);
    const results = [];
    $('.result').each((i, el) => {
      if (results.length >= 20) return;
      const title = $(el).find('.result__title a').text().trim();
      const url = $(el).find('.result__url').attr('href');
      let actualUrl = url;
      if (url && url.includes('uddg=')) {
        actualUrl = decodeURIComponent(url.split('uddg=')[1].split('&')[0]);
      }
      if (title && actualUrl) {
        results.push({ title, url: actualUrl });
      }
    });
    return results;
  } catch (err) {
    console.error('DDG search error:', err);
    return [];
  }
});
