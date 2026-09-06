// Standalone, Electron-free download core.
//
// Extracted from main.js so the same yt-dlp/ffmpeg logic can run inside the
// Electron desktop app AND inside the web server on the VPS.
//
// No Electron, no IPC, no global window. Progress/log/done are delivered through
// an EventEmitter so each caller (Electron main process or the web API) can
// forward them however it likes (IPC, SSE, WebSocket, …).

const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

// ---------- binary resolution ----------

// Order of preference for the bin/ folder:
//   1. VELOX_BIN_DIR env var (set this on the VPS)
//   2. <repo>/bin  (works in dev and in the desktop app)
// Callers may also pass an explicit { binDir } per download.
function defaultBinDir() {
  return process.env.VELOX_BIN_DIR || path.join(__dirname, '..', 'bin');
}

function binaryFileName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function resolveBinary(name, binDir = defaultBinDir()) {
  const local = path.join(binDir, binaryFileName(name));
  if (fs.existsSync(local)) return local;
  return name; // fall back to whatever is on PATH (typical on Linux VPS)
}

function isLocalBinary(binaryPath) {
  return path.isAbsolute(binaryPath) && fs.existsSync(binaryPath);
}

function canRunBinary(name, args, binDir) {
  const binary = resolveBinary(name, binDir);
  if (isLocalBinary(binary)) return true;
  const result = spawnSync(binary, args || ['--version'], { windowsHide: true, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function ffmpegLocationArg(binDir) {
  const ffmpeg = resolveBinary('ffmpeg', binDir);
  return isLocalBinary(ffmpeg) ? path.dirname(ffmpeg) : '';
}

function checkBinaries(binDir = defaultBinDir()) {
  return {
    ytdlp: resolveBinary('yt-dlp', binDir),
    ffmpeg: resolveBinary('ffmpeg', binDir),
    ffprobe: resolveBinary('ffprobe', binDir),
    ytdlpExists: canRunBinary('yt-dlp', ['--version'], binDir),
    ffmpegExists: canRunBinary('ffmpeg', ['-version'], binDir),
    ffprobeExists: canRunBinary('ffprobe', ['-version'], binDir),
    binDir,
  };
}

// ---------- url helpers ----------

function isPornhubUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.replace(/^www\./i, '').toLowerCase();
    return host === 'pornhub.com' || host.endsWith('.pornhub.com');
  } catch {
    return false;
  }
}

function normalizeHttpUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

// ---------- yt-dlp argument builder ----------

function buildArgs(payload, binDir = defaultBinDir()) {
  const {
    url, folder, quality, mode, audioBitrate, isPlaylist,
    vContainer, vCodec, vBitrate, aFormat, referer, sourcePage,
    outputTemplate, socketTimeout, maxRetries, retrySleep,
  } = payload;
  const args = [];
  const ffmpegLocation = ffmpegLocationArg(binDir);
  const hasFfmpeg = canRunBinary('ffmpeg', ['-version'], binDir);
  const hasFfprobe = canRunBinary('ffprobe', ['-version'], binDir);
  const canPostProcess = hasFfmpeg && hasFfprobe;

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

    const codec = ['h264', 'av1', 'vp9'].includes(vCodec) ? vCodec : 'auto';
    const codecFilter = {
      h264: '[vcodec^=avc1]',
      av1: '[vcodec^=av01]',
      vp9: '[vcodec^=vp9]',
    }[codec] || '';
    const formatSort = {
      auto: 'quality,res,fps,hdr:12,vcodec:h264,acodec:aac',
      h264: 'vcodec:h264,lang,quality,res,fps,hdr:12,acodec:aac',
      av1: 'vcodec:av1,lang,quality,res,fps,hdr:12',
      vp9: 'vcodec:vp9,lang,quality,res,fps,hdr:12',
    }[codec];

    const br = Number(vBitrate) > 0 ? `[tbr<=${vBitrate}]` : '';
    const audioFilter = '[acodec^=mp4a]';
    const preferDirectMp4 = isPornhubUrl(url);

    const adaptiveFormat = codecFilter
      ? [
          `bv*${codecFilter}${cap}${br}+ba`,
          `bv*${codecFilter}${cap}+ba`,
          `b${codecFilter}${cap}`,
          `bv*${cap}${br}+ba`,
          `b${cap}`,
          'best',
        ].join('/')
      : [
          `bv*${cap}${br}+ba`,
          `bv*[vcodec^=avc1]${cap}${br}+ba${audioFilter}`,
          `bv*[vcodec^=avc1]${cap}+ba${audioFilter}`,
          `bv*[ext=mp4]${cap}+ba[ext=m4a]`,
          `b${cap}`,
          `bv*${cap}`,
          'best',
        ].join('/');
    const directMp4Formats = h
      ? [
          `b[protocol=https][ext=mp4][height<=${h}]`,
          `${h}p`,
          `b[protocol=https][height<=${h}]`,
        ]
      : [
          'best[protocol=https][ext=mp4]',
          'best[protocol=https]',
        ];
    const format = preferDirectMp4
      ? [...directMp4Formats, adaptiveFormat].join('/')
      : adaptiveFormat;

    const container = ['mp4', 'mkv', 'webm'].includes(vContainer) ? vContainer : 'mp4';
    const merge =
      container === 'webm' ? 'webm/mkv/mp4'
      : container === 'mkv' ? 'mkv/mp4'
      : 'mp4/mkv';

    args.push('-f', format, '--merge-output-format', merge);

    if (container === 'mp4') {
      args.push('-S', formatSort);
      // Remux (container swap) only — never force a full libx264 re-encode. The
      // format sort already prefers h264/aac, so remux is instant and lossless,
      // and it doesn't choke on 4K/HDR/Dolby-Vision sources the way re-encoding
      // to libx264 does (that caused "Postprocessing: Conversion failed").
      args.push('--remux-video', 'mp4');
    } else if (container === 'mkv') {
      args.push('--remux-video', 'mkv');
    } else if (container === 'webm') {
      args.push('--remux-video', 'webm');
    }
  }

  args.push('-o', outputTemplate || path.join(folder, '%(title).80s [%(id)s].%(ext)s'));
  args.push(
    '--newline',
    '--no-warnings',
    '--progress',
    '--progress-template', 'download:[velox] %(progress._percent_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--continue',
    '--windows-filenames',
    '--restrict-filenames',   // ASCII-safe names — fixes [Errno 22] on titles with emoji/� and odd unicode
    '--trim-filenames', '120'
  );
  if (!isPlaylist) args.push('--no-playlist');
  // Network guards (mainly for the server): bail on dead connections fast and
  // cap retries so a hung host can't loop for minutes.
  if (Number(socketTimeout) > 0) args.push('--socket-timeout', String(socketTimeout));
  if (maxRetries != null && Number.isFinite(Number(maxRetries))) {
    args.push('--retries', String(maxRetries), '--fragment-retries', String(maxRetries));
  }
  // Wait between retries instead of burning them all in a fraction of a second.
  // Without this, a Wi-Fi blip exhausts every retry before the link is back.
  if (Number(retrySleep) > 0) {
    args.push('--retry-sleep', String(retrySleep), '--retry-sleep', `fragment:${retrySleep}`);
  }
  if (ffmpegLocation) args.push('--ffmpeg-location', ffmpegLocation);
  const refererUrl = normalizeHttpUrl(referer || sourcePage);
  if (refererUrl) {
    args.push('--referer', refererUrl);
    try {
      args.push('--add-header', `Origin:${new URL(refererUrl).origin}`);
    } catch {}
  }
  args.push(url);

  return args;
}

// ---------- download runner ----------

// Starts a yt-dlp download and returns an EventEmitter.
//
// Events:
//   'progress' -> { percent, size, speed, eta }
//   'log'      -> { message, error? }
//   'done'     -> { ok, code, file, percent, error }
//
// The returned emitter also exposes:
//   .cancel()  -> kill the process (emits no 'done' by default; pass silent=false to emit a cancelled done)
//   .pid       -> child pid
function startDownload(payload, options = {}) {
  const binDir = options.binDir || defaultBinDir();
  const ytdlp = resolveBinary('yt-dlp', binDir);
  const args = buildArgs(payload, binDir);

  const emitter = new EventEmitter();
  const proc = spawn(ytdlp, args, { windowsHide: true });
  emitter.pid = proc.pid;

  let cancelled = false;
  let lastFile = '';
  let lastPercent = 0;
  let lastError = '';

  const naRe = /^(?:N\/A|NA|Unknown)?$/i;

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    text.split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;

      const stableProgressMatch = line.match(/^\[velox\]\s*([\d.]+)%\|([^|]*)\|([^|]*)\|([^|]*)/);
      if (stableProgressMatch) {
        lastPercent = parseFloat(stableProgressMatch[1]);
        const size = stableProgressMatch[2].trim();
        const speed = stableProgressMatch[3].trim();
        const eta = stableProgressMatch[4].trim();
        emitter.emit('progress', {
          percent: lastPercent,
          size: naRe.test(size) ? '' : size,
          speed: naRe.test(speed) ? '' : speed,
          eta: naRe.test(eta) ? '' : eta,
        });
        return;
      }

      const progressMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*([^\s]+))?(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/);
      if (progressMatch) {
        lastPercent = parseFloat(progressMatch[1]);
        emitter.emit('progress', {
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
        emitter.emit('log', { message: `→ ${path.basename(lastFile)}` });
        return;
      }

      const mergeMatch = line.match(/\[Merger\] Merging formats into "(.+)"/);
      if (mergeMatch) {
        lastFile = mergeMatch[1].replace(/^"|"$/g, '');
        emitter.emit('log', { message: 'Merging audio + video…' });
        return;
      }

      if (line.includes('[ExtractAudio]')) emitter.emit('log', { message: 'Extracting audio…' });
      if (line.includes('[VideoRemuxer]')) emitter.emit('log', { message: 'Remuxing for playback compatibility…' });
      if (line.includes('[VideoConvertor]')) emitter.emit('log', { message: 'Converting to a compatible MP4…' });

      emitter.emit('log', { message: line.trim() });
    });
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (!text) return;
    lastError = `${lastError}\n${text}`.slice(-2000);
    emitter.emit('log', { message: text, error: true });
  });

  proc.on('error', (e) => {
    emitter.emit('done', { ok: false, code: null, file: lastFile, percent: lastPercent, error: e.message });
  });

  proc.on('close', (code) => {
    if (cancelled) {
      emitter.emit('done', { ok: false, code, file: lastFile, percent: lastPercent, error: 'cancelled', cancelled: true });
      return;
    }
    const ok = code === 0;
    const error = ok ? '' : (lastError.trim() || `yt-dlp exited ${code}`);
    emitter.emit('done', { ok, code, file: lastFile, percent: lastPercent, error });
  });

  emitter.cancel = () => {
    cancelled = true;
    try { proc.kill(); } catch {}
  };
  // Kill without emitting a cancelled 'done' (used by the desktop pause feature).
  emitter.killSilently = () => {
    cancelled = false;
    proc.removeAllListeners('close');
    try { proc.kill(); } catch {}
  };

  return emitter;
}

module.exports = {
  startDownload,
  buildArgs,
  checkBinaries,
  resolveBinary,
  canRunBinary,
  ffmpegLocationArg,
  isPornhubUrl,
  normalizeHttpUrl,
  defaultBinDir,
};
