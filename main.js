const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { checkBinaries: coreCheckBinaries } = require('./core/downloader');

let mainWindow;
const BRIDGE_PORT = 47813;
const DAY_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MINUTES = Math.max(1, parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES || '5', 10));

// Local server is the default so admin-created keys activate during development.
// For a hosted license server, set LICENSE_SERVER_URL at launch or change this
// fallback URL before shipping a packaged build.
const LICENSE_SERVER_URL =
  (process.env.LICENSE_SERVER_URL || 'http://localhost:4000').replace(/\/+$/, '');
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
// extraction endpoints (/api/extract, /api/resolve) in the thin-client model.
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
  const r = await postJson('/api/signup', { email });
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

// Thin client: search + supported-sites come from the license-gated server,
// so this app ships no yt-dlp of its own.
ipcMain.handle('list-extractors', async () => {
  const lic = readLicense();
  const r = await postJsonAuth('/api/extractors', {}, lic && lic.token);
  if (r.status === 0) return { ok: false, error: `Cannot reach server at ${LICENSE_SERVER_URL}.` };
  return r.body || { ok: false, error: 'could not list sites' };
});

ipcMain.handle('yt-search', async (_e, { query, limit }) => {
  const lic = readLicense();
  const r = await postJsonAuth('/api/search', { query, limit }, lic && lic.token);
  if (r.status === 0) return { ok: false, error: `Cannot reach server at ${LICENSE_SERVER_URL}.` };
  return r.body || { ok: false, error: 'search failed' };
});

ipcMain.handle('read-clipboard', () => {
  const { clipboard } = require('electron');
  return clipboard.readText();
});

// The client only needs ffmpeg/ffprobe (for merge/convert) — never yt-dlp.
ipcMain.handle('check-binaries', () => {
  const info = coreCheckBinaries(electronBinDir());
  info.clientReady = info.ffmpegExists && info.ffprobeExists; // yt-dlp not required here
  return info;
});

ipcMain.handle('fetch-info', async (_e, url) => {
  const lic = readLicense();
  const r = await postJsonAuth('/api/extract', { url }, lic && lic.token);
  if (!(r.status === 200 && r.body && r.body.ok && r.body.meta)) {
    return { ok: false, error: r.body?.error || 'could not read this link' };
  }
  const m = r.body.meta;
  return { ok: true, title: m.title, uploader: m.uploader, duration: m.duration, thumbnail: m.thumbnail, isPlaylist: m.isPlaylist };
});

// renderer job id -> { jobId, payload, sender, sseReq, paused }
const clientJobs = new Map();

function stopActiveDownloads(reason) {
  const lic = readLicense();
  for (const [id, cj] of clientJobs.entries()) {
    clientJobs.delete(id);
    try { cj.sseReq && cj.sseReq.abort(); } catch {}
    postJsonAuth(`/api/download/${cj.jobId}/cancel`, {}, lic && lic.token);
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

// ---------- thin-client model: server extracts, device downloads ----------

// Probe a URL via the license-gated server endpoint → metadata + option menu.
ipcMain.handle('client-extract', async (_e, url) => {
  if (LICENSE_BYPASS) return { ok: false, error: 'extraction requires a server connection' };
  const lic = readLicense();
  const r = await postJsonAuth('/api/extract', { url: String(url || '') }, lic && lic.token);
  if (r.status === 0) return { ok: false, error: `Cannot reach server at ${LICENSE_SERVER_URL}.` };
  if (r.status === 401 || r.status === 403 || r.status === 409) {
    notifyLicenseInvalidated({ reason: 'license-invalid', message: r.body?.error || 'License is not active.' });
    return { ok: false, error: r.body?.error || 'License is not active.' };
  }
  return r.body || { ok: false, error: 'extract failed' };
});

function parseDispositionName(header) {
  if (!header) return '';
  const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].replace(/"/g, '').trim()); } catch {} }
  const plain = header.match(/filename="?([^"]+)"?/i);
  return plain ? plain[1].trim() : '';
}

// Consume a Server-Sent Events stream over Electron's net. Returns the request
// so it can be aborted.
function openSse(urlPath, token, handlers) {
  const req = net.request({ method: 'GET', url: LICENSE_SERVER_URL + urlPath });
  if (token) req.setHeader('Authorization', `Bearer ${token}`);
  req.on('response', (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString();
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let ev = 'message', data = '';
        frame.split(/\r?\n/).forEach((line) => {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        });
        if (data) { try { handlers.onEvent(ev, JSON.parse(data)); } catch {} }
      }
    });
    res.on('end', () => handlers.onEnd && handlers.onEnd());
  });
  req.on('error', (e) => handlers.onError && handlers.onError(e));
  req.end();
  return req;
}

// Stream the finished file from the server to the user's chosen folder.
function fetchFileToFolder(jobId, token, folder, fallbackName) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url: `${LICENSE_SERVER_URL}/api/download/${jobId}/file` });
    if (token) req.setHeader('Authorization', `Bearer ${token}`);
    req.on('response', (res) => {
      if (res.statusCode !== 200) { res.on('data', () => {}); res.on('end', () => reject(new Error(`file transfer ${res.statusCode}`))); return; }
      const name = parseDispositionName(res.headers['content-disposition']) || fallbackName || 'video';
      const dest = path.join(folder, name);
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => out.write(c));
      res.on('end', () => out.end(() => resolve(dest)));
      res.on('error', reject);
      out.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// Server runs the full yt-dlp download (reliable for YouTube/HLS/pornhub/merge),
// streams progress here over SSE, then we pull the finished file to disk.
async function startServerDownload(id, payload, sender) {
  const lic = readLicense();
  const token = lic && lic.token;
  const send = (channel, data) => { if (sender && !sender.isDestroyed()) sender.send(channel, { id, ...data }); };

  const r = await postJsonAuth('/api/download/create', {
    url: payload.url, mode: payload.mode, quality: payload.quality,
    audioBitrate: payload.audioBitrate, aFormat: payload.aFormat,
    vContainer: payload.vContainer, vCodec: payload.vCodec, vBitrate: payload.vBitrate,
    referer: payload.referer,
  }, token);
  if (r.status === 0) return { ok: false, error: `Cannot reach server at ${LICENSE_SERVER_URL}.` };
  if (r.status === 401 || r.status === 403 || r.status === 409) {
    notifyLicenseInvalidated({ reason: 'license-invalid', message: r.body?.error || 'License is not active.' });
    return { ok: false, error: r.body?.error || 'License is not active.' };
  }
  if (!(r.status === 200 && r.body && r.body.ok)) return { ok: false, error: r.body?.error || `download failed (${r.status})` };

  const jobId = r.body.id;
  const entry = { jobId, payload, sender, sseReq: null, paused: false };
  clientJobs.set(id, entry);

  entry.sseReq = openSse(`/api/download/${jobId}/events`, token, {
    onEvent: async (ev, d) => {
      if (ev === 'update') send('download-progress', { percent: d.percent, size: d.size, speed: d.speed, eta: d.eta });
      else if (ev === 'log') send('download-log', { message: d.message, error: d.error });
      else if (ev === 'end') {
        if (d.status === 'done') {
          send('download-log', { message: 'Saving to your device…' });
          try {
            const dest = await fetchFileToFolder(jobId, token, payload.folder, payload.title);
            send('download-done', { ok: true, file: dest, percent: 100 });
          } catch (e) {
            send('download-done', { ok: false, error: `file transfer failed: ${e.message}` });
          }
        } else {
          send('download-done', { ok: false, error: d.error || 'download failed' });
        }
        clientJobs.delete(id);
      }
    },
  });
  return { ok: true };
}

ipcMain.handle('client-download', async (event, payload) => {
  const license = await requireActiveLicenseForWork();
  if (!license.ok) return license;
  return startServerDownload(payload.id, payload, event.sender);
});

// Pause: stop the server job + our stream; keep the config so resume can restart.
ipcMain.handle('pause-download', async (_e, id) => {
  const cj = clientJobs.get(id);
  if (!cj) return false;
  try { cj.sseReq && cj.sseReq.abort(); } catch {}
  const lic = readLicense();
  postJsonAuth(`/api/download/${cj.jobId}/cancel`, {}, lic && lic.token);
  cj.paused = true;
  return true;
});

// Resume: start a fresh server job for the same renderer id.
ipcMain.handle('resume-download', async (event, id) => {
  const license = await requireActiveLicenseForWork();
  if (!license.ok) return false;
  const cj = clientJobs.get(id);
  if (!cj) return false;
  const r = await startServerDownload(id, cj.payload, event.sender);
  return !!r.ok;
});

ipcMain.handle('cancel-download', async (_e, id) => {
  const cj = clientJobs.get(id);
  if (cj) {
    try { cj.sseReq && cj.sseReq.abort(); } catch {}
    const lic = readLicense();
    postJsonAuth(`/api/download/${cj.jobId}/cancel`, {}, lic && lic.token);
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
