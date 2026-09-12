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
// Phase 0 of the native engine. Loading it never throws and never touches the
// DLL unless it is asked to, so this require is free on an install without one.
const engine = require('./engine');

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

// What a binary is called on disk in a shipped build, in the order to look for
// it. The download engine is yt-dlp, but a customer browsing
// Program Files\Velox Downloader\resources\bin should see the product they
// paid for rather than the name of a tool they could have downloaded
// themselves — so the packaged build ships it as velox-core.exe
// (scripts/brand-engine.js). The original name stays in the list so a dev
// checkout with a plain yt-dlp.exe, and the Linux VPS where it comes from
// PATH, both keep working untouched.
const SHIPPED_AS = {
  'yt-dlp': ['velox-core', 'yt-dlp'],
};

// The engine talks about itself by name — "Update yt-dlp to the latest
// version", "yt-dlp is out of date" — and those lines are forwarded straight
// to the customer's screen. Nothing about the engine's identity helps them, so
// it is taken out of anything on its way to the UI. Errors keep their meaning:
// only the name is replaced, never the sentence.
function scrubEngineName(text) {
  return String(text == null ? '' : text)
    // Links to the engine's own project page go first, and go whole: a customer
    // who follows one only learns what the rename was for. Doing this after the
    // name replacement would leave "github.com/the download engine".
    .replace(/\(?\s*(?:see\s+)?https?:\/\/\S*yt-dlp\S*\)?/gi, '')
    .replace(/\byt[-_ ]?dlp(\.exe)?\b/gi, 'the download engine')
    .replace(/\bvelox-core(\.exe)?\b/gi, 'the download engine')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function resolveBinary(name, binDir = defaultBinDir()) {
  for (const candidate of SHIPPED_AS[name] || [name]) {
    const local = path.join(binDir, binaryFileName(candidate));
    if (fs.existsSync(local)) return local;
  }
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

// YouTube's default player client refuses a growing share of ordinary videos
// with "This video is not available", while the android client still serves
// them. Ask for both: yt-dlp merges what each returns, so nothing is lost on
// videos the default client handles fine, and the ones it rejects still work.
// Override with VELOX_YT_PLAYER_CLIENTS, or set it to "off" to send nothing.
const DEFAULT_YT_CLIENTS = 'default,android';

// Split a download into parallel parts, the way a download manager does.
//
// Streams that arrive as fragments (HLS/DASH, which is most of what these
// sites serve) were being fetched one fragment at a time: measured 328s for a
// 466MB stream. Eight at once brought the same file down in 35s — 9.3x. Bigger
// HTTP chunks were measured too and came out slightly slower, so they are not
// used. Tune with VELOX_PARALLEL_PARTS; 1 disables it.
const DEFAULT_PARALLEL_PARTS = 8;

// YouTube counts connections, not downloads. Eight fragments at once times the
// three bulk jobs the UI allows is 24 simultaneous requests from one address,
// and that is what earns "Sign in to confirm you're not a bot" — the block is
// on the connection, not the account, which is why signing in never fixed it
// and a phone hotspot always did.
//
// Four costs nothing: the same 29MB 1080p stream measured 7.5s at four
// fragments against 7.7s at eight, because the 9.3x win above is already
// banked by the first few connections. A three-job bulk run drops from 24
// simultaneous requests to 12.
const YT_PARALLEL_PARTS = 4;

function parallelPartsArgs(url) {
  const raw = parseInt(process.env.VELOX_PARALLEL_PARTS || '', 10);
  if (Number.isFinite(raw) && raw > 0) return ['--concurrent-fragments', String(Math.min(raw, 16))];
  const parts = isYouTubeUrl(url) ? YT_PARALLEL_PARTS : DEFAULT_PARALLEL_PARTS;
  return ['--concurrent-fragments', String(parts)];
}

const YT_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com)$/i;

function isYouTubeUrl(url) {
  try { return YT_HOSTS.test(new URL(String(url)).hostname); } catch { return false; }
}

// Pace the metadata requests so a burst of jobs does not arrive as one spike.
// Only the small API calls are slowed; the media fragments are untouched, so
// this costs a second or two per job and no download speed at all.
function politenessArgs(url) {
  if (!isYouTubeUrl(url)) return [];
  if (String(process.env.VELOX_NO_THROTTLE || '') === '1') return [];
  return ['--sleep-requests', '1', '--sleep-interval', '1', '--max-sleep-interval', '5'];
}

// A single non-fragmented file cannot be split by yt-dlp's own downloader —
// only an external one can open several connections to it. If aria2c happens
// to be available we hand off to it; if not, nothing changes.
function externalDownloaderArgs(binDir, url) {
  if (String(process.env.VELOX_DISABLE_ARIA2 || '') === '1') return [];
  const aria = resolveBinary('aria2c', binDir);
  if (!isLocalBinary(aria)) {
    const probe = spawnSync(aria, ['--version'], { windowsHide: true, stdio: 'ignore' });
    if (probe.error || probe.status !== 0) return [];
  }
  const parts = parallelPartsArgs(url)[1];
  return [
    '--downloader', aria,
    '--downloader-args', `aria2c:-x${parts} -s${parts} -k1M --file-allocation=none`,
  ];
}

// VELOX_YTDLP_COOKIES is the operator-supplied file; VELOX_YTDLP_COOKIES_AUTO
// is the one the app writes from the Browser tab's own session.
function cookieFile() {
  for (const key of [process.env.VELOX_YTDLP_COOKIES, process.env.VELOX_YTDLP_COOKIES_AUTO]) {
    if (key && fs.existsSync(key)) return key;
  }
  return '';
}

// A JavaScript runtime for YouTube's challenges.
//
// yt-dlp warns "No supported JavaScript runtime could be found ... some formats
// may be missing" without one, and YouTube's challenges then go unsolved, which
// is what surfaced to users as "Sign in to confirm you're not a bot". Only deno
// is enabled by default and nothing was shipped, so every install was running
// in that degraded mode.
//
// QuickJS is the runtime to bundle: 2MB against Node's 87MB.
//
// It is NOT on by default, because measured on this machine it costs about ten
// seconds an extraction and returned exactly the same 49 formats at 2160p as
// running without it: 14.6s with, 4.1s without, identical output. QuickJS is an
// interpreter with no JIT, and YouTube's challenge is heavy.
//
// So it is kept for the retry after a failure, where ten seconds is worth
// spending, rather than charged to every download that was going to work.
// Pass { jsRuntime: true } to ask for it.
function jsRuntimeArgs(binDir, enable) {
  if (!enable) return [];
  return jsRuntimeArgsForced(binDir);
}

function jsRuntimeArgsForced(binDir) {
  // path.resolve, not isLocalBinary: a caller passing a relative bin dir (the
  // server does) would otherwise resolve the file, fail the isAbsolute test and
  // silently drop the runtime — the exact degraded mode this is here to end.
  const qjs = path.resolve(resolveBinary('qjs', binDir));
  // Only pass the flag when the binary is really there. Naming a runtime that
  // does not exist makes yt-dlp fail the whole extraction rather than fall back.
  if (!fs.existsSync(qjs)) return [];
  // No path in the flag. "quickjs:<path>" is the documented form but it does
  // not survive a space in the path, and the installed app lives under
  // C:\Program Files: measured "JS runtimes: none" from the real bin folder
  // against "quickjs-ng-0.16.2" from a folder with no spaces. The binary is
  // found on PATH instead, which is spliced in by jsRuntimeEnv() below, and a
  // PATH entry may contain spaces safely.
  return ['--js-runtimes', 'quickjs'];
}

// PATH for the spawned yt-dlp, with the bundled binaries in front so it finds
// qjs without a path argument. Returns undefined when there is nothing to add,
// so callers can spread it and leave the environment untouched.
function jsRuntimeEnv(binDir) {
  const dir = path.resolve(binDir || defaultBinDir());
  if (!fs.existsSync(path.join(dir, binaryFileName('qjs')))) return undefined;
  const sep = process.platform === 'win32' ? ';' : ':';
  return { ...process.env, PATH: dir + sep + (process.env.PATH || '') };
}

// YouTube binds every media URL to the address that asked for it — the
// `ip=` parameter inside the googlevideo link. A dual-stack Windows machine
// holds two global IPv6 addresses at once (one of them a rotating temporary
// one), and the media fetch can leave from the other one, which googlevideo
// answers with a bare "403 Forbidden". Extraction succeeds, so it surfaced as
// a download that dies with "unable to download video data: HTTP Error 403"
// on a video whose title and thumbnail had already loaded.
//
// Measured on a dual-stack connection: 5 of 6 videos 403 over IPv6, 6 of 6
// fine over IPv4 — including a full 1080p download that had been failing.
// So YouTube goes over IPv4. `allowIpv6` (set by the retry in main.js) drops
// the flag again for anyone whose network has no IPv4 at all, and
// VELOX_FORCE_IPV4=0 turns the whole thing off.
function ipStackArgs(url, payload) {
  if (payload.allowIpv6) return [];
  if (String(process.env.VELOX_FORCE_IPV4 || '') === '0') return [];
  return isYouTubeUrl(url) ? ['--force-ipv4'] : [];
}

function youtubeClientArgs() {
  const raw = (process.env.VELOX_YT_PLAYER_CLIENTS || '').trim();
  if (raw.toLowerCase() === 'off') return [];
  const clients = raw || DEFAULT_YT_CLIENTS;
  return ['--extractor-args', `youtube:player_client=${clients}`];
}

function buildArgs(payload, binDir = defaultBinDir()) {
  const {
    url, folder, quality, mode, audioBitrate, isPlaylist,
    vContainer, vCodec, vBitrate, aFormat, referer, sourcePage,
    outputTemplate, socketTimeout, maxRetries, retrySleep, proxy, limitRate,
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
  // A cap in bytes/sec, already normalised by the caller. Downloading at full
  // speed makes the rest of the house unusable on a home line, which is the
  // single most common complaint about any download manager.
  if (limitRate) args.push('--limit-rate', String(limitRate));
  args.push(...jsRuntimeArgs(binDir, payload.jsRuntime));
  args.push(...parallelPartsArgs(url));
  args.push(...externalDownloaderArgs(binDir, url));
  args.push(...politenessArgs(url));
  args.push(...youtubeClientArgs());
  args.push(...ipStackArgs(url, payload));
  // Set by main.js from the user's proxy setting. Empty unless the proxy is on
  // and its scope covers this url, so an untouched install sends nothing.
  if (proxy) args.push('--proxy', String(proxy));
  const cookies = cookieFile();
  if (cookies) args.push('--cookies', cookies);
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

  // Native engine, Phase 0: identical arguments and the same yt-dlp binary, but
  // the process lifecycle, the line parsing and the event stream come from
  // velox_engine.dll instead of from this file. It is opt-in behind
  // VELOX_ENGINE=1 and returns null when the DLL is absent, so a release with a
  // missing or misbuilt engine behaves exactly as it does today.
  if (engine.enabled(binDir)) {
    const native = engine.startDownload(args, { binDir, url: payload.url });
    if (native) return native;
  }

  const emitter = new EventEmitter();
  
  let proc;
  const netflixMatch = payload.url.match(/^https?:\/\/(www\.)?netflix\.com\/(title|watch)\/(\d+)/i);
  if (netflixMatch) {
    const netflixId = netflixMatch[3];
    const netflixArgs = ['NFripper.py', netflixId, '--high', '--ns', '--na'];
    const netflixDir = path.join(binDir, 'Netflix-DL');
    proc = spawn('python', netflixArgs, { windowsHide: true, cwd: netflixDir });
  } else {
    // env carries the bundled bin folder on PATH so yt-dlp can find qjs by name;
    // see jsRuntimeArgs for why the path cannot be passed in the flag itself.
    proc = spawn(ytdlp, args, { windowsHide: true, env: jsRuntimeEnv(binDir) });
  }

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

      // Post-processors rename the file: an MP3 job downloads a .m4a and then
      // writes a .mp3, a remux swaps the container. Without these the finished
      // path we report is the intermediate one, which no longer exists, so
      // "open file" from the library pointed at nothing.
      const postMatch = line.match(/\[(?:ExtractAudio|VideoRemuxer|VideoConvertor)\][^;]*(?:;\s*)?Destination: (.+)/);
      if (postMatch) lastFile = postMatch[1].trim();

      if (line.includes('[ExtractAudio]')) emitter.emit('log', { message: 'Extracting audio…' });
      if (line.includes('[VideoRemuxer]')) emitter.emit('log', { message: 'Remuxing for playback compatibility…' });
      if (line.includes('[VideoConvertor]')) emitter.emit('log', { message: 'Converting to a compatible MP4…' });

      emitter.emit('log', { message: scrubEngineName(line) });
    });
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (!text) return;
    lastError = `${lastError}\n${scrubEngineName(text)}`.slice(-2000);
    emitter.emit('log', { message: scrubEngineName(text), error: true });
  });

  proc.on('error', (e) => {
    emitter.emit('done', { ok: false, code: null, file: lastFile, percent: lastPercent, error: e.message });
  });

  proc.on('close', (code) => {
    if (cancelled) {
      emitter.emit('done', { ok: false, code, file: lastFile, percent: lastPercent, error: 'cancelled', cancelled: true });
      return;
    }

    let ok = code === 0;

    if (netflixMatch) {
      let fileFound = false;
      const netflixDownloads = path.join(binDir, 'Netflix-DL', 'downloads', 'netflix');
      try {
        if (fs.existsSync(netflixDownloads)) {
          const files = fs.readdirSync(netflixDownloads);
          const mp4File = files.find(f => f.endsWith('.mp4') || f.endsWith('.mkv'));
          if (mp4File) {
            const oldPath = path.join(netflixDownloads, mp4File);
            const newPath = path.join(payload.folder, mp4File);
            fs.renameSync(oldPath, newPath);
            lastFile = newPath;
            fileFound = true;
          }
        }
      } catch (e) {}

      if (!fileFound) {
        ok = false;
        if (!lastError.trim()) lastError = 'Netflix-DL did not output any video file. Check logs for details.';
      }
    }

    const error = ok ? '' : (lastError.trim() || `the download engine stopped (code ${code})`);
    emitter.emit('done', { ok, code, file: lastFile, percent: lastPercent, error });
  });

  emitter.cancel = (silent = true) => {
    cancelled = true;
    try { proc.kill('SIGINT'); } catch {}
    try { proc.kill('SIGTERM'); } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    if (!silent) emitter.emit('done', { ok: false, code: null, file: lastFile, percent: lastPercent, error: 'cancelled', cancelled: true });
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
  // Diagnostics for a preflight/about screen: whether the native engine is
  // present, which DLL was bound, and whether it is switched on.
  engineStatus: (binDir) => engine.status(binDir || defaultBinDir()),
  buildArgs,
  jsRuntimeArgs,
  jsRuntimeArgsForced,
  jsRuntimeEnv,
  checkBinaries,
  resolveBinary,
  scrubEngineName,
  canRunBinary,
  ffmpegLocationArg,
  isPornhubUrl,
  normalizeHttpUrl,
  defaultBinDir,
};
