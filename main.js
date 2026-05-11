const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

let mainWindow;
const BRIDGE_PORT = 47813;

const LICENSE_SERVER_URL =
  process.env.LICENSE_SERVER_URL || 'https://api.example.com'; // <-- replace before shipping
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
        url: LICENSE_SERVER_URL.replace(/\/$/, '') + urlPath,
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

async function licenseStatus() {
  if (LICENSE_BYPASS) return { licensed: true, bypass: true };
  const lic = readLicense();
  if (!lic || !lic.token) return { licensed: false, reason: 'no-license' };
  return { licensed: true, email: lic.email, key: lic.key };
}

async function doSignup(email) {
  const r = await postJson('/api/signup', { email });
  if (r.status === 200 && r.body && r.body.ok) return { ok: true, key: r.body.key };
  return { ok: false, error: r.body?.error || `signup failed (${r.status})` };
}

async function doActivate(key) {
  const did = deviceId();
  const r = await postJson('/api/activate', { key, deviceId: did, deviceName: deviceName() });
  if (r.status === 200 && r.body?.ok) {
    writeLicense({
      key,
      token: r.body.token,
      email: r.body.email || '',
      deviceId: did,
      activatedAt: Date.now(),
    });
    return { ok: true };
  }
  return { ok: false, error: r.body?.error || `activate failed (${r.status})` };
}

async function doHeartbeat() {
  const lic = readLicense();
  if (!lic || !lic.token) return { ok: false, revoked: false, reason: 'no-license' };
  const r = await postJson('/api/heartbeat', { token: lic.token });
  if (r.status === 200 && r.body?.ok) return { ok: true, revoked: false };
  if (r.status === 403 && r.body?.revoked) {
    clearLicense();
    return { ok: false, revoked: true };
  }
  if (r.status === 401 || r.status === 409) {
    // token invalid or device mismatch — force re-activation
    clearLicense();
    return { ok: false, revoked: false, reason: 'token-invalid' };
  }
  // transient (network down) — don't lock
  return { ok: true, revoked: false, transient: true };
}

let heartbeatTimer = null;
function startHeartbeatLoop() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    const r = await doHeartbeat();
    if (r.revoked && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('license-revoked');
    }
  }, 30 * 60 * 1000); // 30 min
}

function resolveBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const local = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', exe)
    : path.join(__dirname, 'bin', exe);
  if (fs.existsSync(local)) return local;
  return name;
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
  createWindow();
  startBridgeServer();

  // Background heartbeat (every 30 min)
  startHeartbeatLoop();

  // Immediate heartbeat after window loads — if revoked, ask renderer to show lock
  mainWindow.webContents.once('did-finish-load', async () => {
    if (LICENSE_BYPASS) return;
    const r = await doHeartbeat();
    if (r.revoked && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('license-revoked');
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

ipcMain.handle('list-extractors', async () => {
  return new Promise((resolve) => {
    const ytdlp = resolveBinary('yt-dlp');
    const proc = spawn(ytdlp, ['--color', 'never', '--list-extractors'], {
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: err || `yt-dlp exited ${code}` });
      // Strip ANSI escape sequences defensively
      const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
      const list = out
        .replace(ansi, '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      resolve({ ok: true, list });
    });
  });
});

ipcMain.handle('yt-search', async (_e, { query, limit }) => {
  return new Promise((resolve) => {
    const q = String(query || '').trim();
    if (!q) return resolve({ ok: false, error: 'empty query' });
    const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
    const ytdlp = resolveBinary('yt-dlp');
    const args = ['-J', '--flat-playlist', '--no-warnings', `ytsearch${n}:${q}`];
    const proc = spawn(ytdlp, args, { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: err || `yt-dlp exited ${code}` });
      try {
        const json = JSON.parse(out);
        const items = (json.entries || []).map((e) => ({
          id: e.id,
          title: e.title || '',
          url: e.url && /^https?:/i.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
          channel: e.channel || e.uploader || '',
          duration: e.duration || 0,
          thumbnail: e.thumbnails && e.thumbnails.length
            ? e.thumbnails[e.thumbnails.length - 1].url
            : (e.thumbnail || `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`),
        }));
        resolve({ ok: true, items });
      } catch (e) {
        resolve({ ok: false, error: 'Failed to parse search results' });
      }
    });
  });
});

ipcMain.handle('read-clipboard', () => {
  const { clipboard } = require('electron');
  return clipboard.readText();
});

ipcMain.handle('check-binaries', () => {
  const ytdlp = resolveBinary('yt-dlp');
  const ffmpeg = resolveBinary('ffmpeg');
  return {
    ytdlp,
    ffmpeg,
    ytdlpExists: fs.existsSync(ytdlp) || ytdlp === 'yt-dlp',
    ffmpegExists: fs.existsSync(ffmpeg) || ffmpeg === 'ffmpeg',
    binDir: app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(__dirname, 'bin'),
  };
});

ipcMain.handle('fetch-info', async (_e, url) => {
  return new Promise((resolve) => {
    const ytdlp = resolveBinary('yt-dlp');
    const args = ['-J', '--no-warnings', '--no-playlist', url];
    const proc = spawn(ytdlp, args, { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: err || `yt-dlp exited ${code}` });
      try {
        const json = JSON.parse(out);
        resolve({
          ok: true,
          title: json.title,
          uploader: json.uploader || json.channel || '',
          duration: json.duration || 0,
          thumbnail: json.thumbnail || '',
          isPlaylist: json._type === 'playlist',
        });
      } catch (e) {
        resolve({ ok: false, error: 'Failed to parse video info' });
      }
    });
  });
});

const activeJobs = new Map();
const jobConfigs = new Map();

function buildArgs(payload) {
  const {
    url, folder, quality, mode, audioBitrate, isPlaylist,
    vContainer, vCodec, vBitrate, aFormat,
  } = payload;
  const ffmpeg = resolveBinary('ffmpeg');
  const args = [];

  if (mode === 'audio') {
    const fmt = ['mp3', 'm4a', 'opus', 'flac'].includes(aFormat) ? aFormat : 'mp3';
    args.push('-x', '--audio-format', fmt);
    if (fmt !== 'flac') {
      args.push('--audio-quality', `${audioBitrate || 192}K`);
    }
  } else {
    const heightCap = {
      best: null,
      '4k': 2160,
      '1440p': 1440,
      '1080p': 1080,
      '720p': 720,
      '480p': 480,
      '360p': 360,
    }[quality];
    const h = heightCap;
    const cap = h ? `[height<=${h}]` : '';

    const codecFilter = {
      h264: '[vcodec^=avc1]',
      av1: '[vcodec^=av01]',
      vp9: '[vcodec^=vp9]',
    }[vCodec] || '';

    const br = Number(vBitrate) > 0 ? `[tbr<=${vBitrate}]` : '';

    const format = codecFilter
      ? [
          `bv*${codecFilter}${cap}${br}+ba`,
          `bv*${codecFilter}${cap}+ba`,
          `b${codecFilter}${cap}`,
          `bv*${cap}${br}+ba`,
          `b${cap}`,
          'best',
        ].join('/')
      : [
          `bv*[vcodec^=avc1]${cap}${br}+ba[acodec^=mp4a]`,
          `bv*[vcodec^=avc1]${cap}+ba`,
          `bv*[ext=mp4]${cap}+ba[ext=m4a]`,
          `bv*${cap}[vcodec!*=av01]+ba`,
          `b${cap}[vcodec^=avc1]`,
          `b${cap}[vcodec!*=av01]`,
          `b${cap}`,
          `bv*${cap}`,
          'best',
        ].join('/');

    const container = ['mp4', 'mkv', 'webm'].includes(vContainer) ? vContainer : 'mp4';
    const merge =
      container === 'webm' ? 'webm/mkv/mp4'
      : container === 'mkv' ? 'mkv/mp4'
      : 'mp4/mkv';

    args.push('-f', format, '--merge-output-format', merge);
  }

  args.push('-o', path.join(folder, '%(title)s [%(id)s].%(ext)s'));
  args.push('--newline', '--no-warnings', '--progress', '--continue');
  if (!isPlaylist) args.push('--no-playlist');
  if (fs.existsSync(ffmpeg)) args.push('--ffmpeg-location', ffmpeg);
  args.push(url);

  return args;
}

function spawnDownload(id, payload, sender) {
  const ytdlp = resolveBinary('yt-dlp');
  const args = buildArgs(payload);

  const send = (channel, data) => {
    if (sender && !sender.isDestroyed()) sender.send(channel, { id, ...data });
  };

  const proc = spawn(ytdlp, args, { windowsHide: true });
  activeJobs.set(id, proc);

  let lastFile = '';
  let lastPercent = 0;

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    text.split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      const progressMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*([^\s]+))?(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/);
      if (progressMatch) {
        lastPercent = parseFloat(progressMatch[1]);
        send('download-progress', {
          percent: lastPercent,
          size: progressMatch[2] || '',
          speed: progressMatch[3] || '',
          eta: progressMatch[4] || '',
        });
        return;
      }
      const destMatch = line.match(/\[download\] Destination: (.+)/);
      if (destMatch) {
        lastFile = destMatch[1].trim();
        send('download-log', { message: `→ ${path.basename(lastFile)}` });
        return;
      }
      const mergeMatch = line.match(/\[Merger\] Merging formats into "(.+)"/);
      if (mergeMatch) {
        lastFile = mergeMatch[1].replace(/^"|"$/g, '');
        send('download-log', { message: 'Merging audio + video…' });
        return;
      }
      if (line.includes('[ExtractAudio]')) {
        send('download-log', { message: 'Extracting audio…' });
      }
      send('download-log', { message: line.trim() });
    });
  });

  proc.stderr.on('data', (data) => {
    send('download-log', { message: data.toString().trim(), error: true });
  });

  proc.on('error', (e) => {
    activeJobs.delete(id);
    send('download-done', { ok: false, error: e.message });
  });

  proc.on('close', (code) => {
    const wasPaused = !activeJobs.has(id);
    activeJobs.delete(id);
    if (wasPaused) return;
    const ok = code === 0;
    send('download-done', { ok, code, file: lastFile, percent: lastPercent });
  });
}

ipcMain.handle('start-download', async (event, payload) => {
  jobConfigs.set(payload.id, payload);
  spawnDownload(payload.id, payload, event.sender);
  return { ok: true };
});

ipcMain.handle('pause-download', (_e, id) => {
  const proc = activeJobs.get(id);
  if (proc) {
    activeJobs.delete(id);
    proc.kill();
    return true;
  }
  return false;
});

ipcMain.handle('resume-download', (event, id) => {
  const cfg = jobConfigs.get(id);
  if (!cfg) return false;
  spawnDownload(id, cfg, event.sender);
  return true;
});

ipcMain.handle('cancel-download', (_e, id) => {
  const proc = activeJobs.get(id);
  if (proc) {
    activeJobs.delete(id);
    proc.kill();
  }
  jobConfigs.delete(id);
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
ipcMain.handle('license-clear',    () => { clearLicense(); return { ok: true }; });
ipcMain.handle('license-heartbeat',() => doHeartbeat());

ipcMain.handle('window-control', (_e, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
});
