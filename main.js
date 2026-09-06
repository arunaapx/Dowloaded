const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { checkBinaries: coreCheckBinaries, startDownload } = require('./core/downloader');
const { probe, search: ytSearch, listExtractors } = require('./core/extractor');

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

// Ships pointing at the hosted license + extraction server. For local dev,
// override with the LICENSE_SERVER_URL env var (e.g. http://localhost:4000).
const LICENSE_SERVER_URL =
  (process.env.LICENSE_SERVER_URL || 'https://downloader.prolanka.online').replace(/\/+$/, '');
const LICENSE_BYPASS = process.env.LICENSE_BYPASS === '1';

const HISTORY_PATH = () => path.join(app.getPath('userData'), 'history.json');
const LICENSE_PATH = () => path.join(app.getPath('userData'), 'license.json');

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
          catch { resolve({ status: res.statusCode, body: { ok: false, error: 'parse' } }); }
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
          catch { resolve({ status: res.statusCode, body: { ok: false, error: 'parse' } }); }
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
    return { ok: true, revoked: false, profile: profileFromLicense(updated) };
  }
  if (r.status === 403 && (r.body?.revoked || r.body?.blocked || r.body?.expired)) {
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

app.whenReady().then(async () => {
  // Let the core downloader resolve bundled binaries in packaged builds.
  process.env.VELOX_BIN_DIR = electronBinDir();
  createWindow();
  startBridgeServer();

  // Background heartbeat (every 30 min)
  startHeartbeatLoop();

  // Immediate heartbeat after window loads — if admin changed access, ask renderer to show lock
  mainWindow.webContents.once('did-finish-load', async () => {
    if (LICENSE_BYPASS) return;
    const r = await doHeartbeat();
    if (!r.ok && !r.transient && mainWindow && !mainWindow.isDestroyed()) {
      notifyLicenseInvalidated(r);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
  return ytSearch(query, limit, { binDir: electronBinDir(), ...YTDLP_OPTS });
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
  const info = await probe(String(url || ''), { binDir: electronBinDir(), ...YTDLP_OPTS });
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

// ---------- device-side model: THIS device extracts + downloads with its own
// yt-dlp (residential IP → YouTube works); the server only gates the license. ----

// Probe a URL locally → metadata + the option menu the renderer shows.
ipcMain.handle('client-extract', async (_e, url) => {
  const info = await probe(String(url || ''), { binDir: electronBinDir(), ...YTDLP_OPTS });
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
function startLocalDownload(id, payload, sender) {
  const send = (channel, data) => { if (sender && !sender.isDestroyed()) sender.send(channel, { id, ...data }); };
  const handle = startDownload({ ...DOWNLOAD_OPTS, ...payload }, { binDir: electronBinDir() });
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
    // Keep the job registered so Retry (and auto-retry when the network comes
    // back) can restart it. yt-dlp's --continue resumes from the .part file, so
    // nothing already downloaded is lost.
    const cj = clientJobs.get(id);
    if (cj) { cj.handle = null; cj.failed = true; }
    send('download-done', { ok: false, error: d.error || 'download failed', resumable: !!cj });
  });
  return { ok: true };
}

ipcMain.handle('client-download', async (event, payload) => {
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

ipcMain.handle('window-control', (_e, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
});
