const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

let mainWindow;
const BRIDGE_PORT = 47813;

const HISTORY_PATH = () => path.join(app.getPath('userData'), 'history.json');

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

app.whenReady().then(() => {
  createWindow();
  startBridgeServer();
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

ipcMain.handle('window-control', (_e, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
});
