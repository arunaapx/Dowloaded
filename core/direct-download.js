// Downloader for media URLs we already hold.
//
// The normal path hands a page URL to yt-dlp and lets it work out the streams.
// That fails on videos YouTube refuses to anonymous requests: measured on
// 7s1HX4Xso9M, where nine player clients, a cookie jar, a JS runtime and a full
// Chromium window all came back "Sign in to confirm you are not a bot".
//
// When the streams are instead read out of the user's own signed-in browser
// session (see browserExtract in main.js), what comes back is a plain https URL
// per format, and this module fetches those. Measured on that same refused
// video: 35 formats up to 2160p.
//
// googlevideo throttles a single connection to roughly 0.8 MB/s. Measured on a
// 77MB stream: 0.92 MB/s on one connection, 3.18 on four, 5.68 on eight, so the
// cap is per connection and parallel range requests are the way around it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { resolveBinary, defaultBinDir } = require('./downloader');
const engine = require('./engine');

const CHUNK = 4 * 1024 * 1024;
const DEFAULT_CONNECTIONS = 8;
const MAX_ATTEMPTS = 4;

// These URLs are issued to a specific client, and googlevideo checks that the
// user agent still matches when the bytes are fetched.
const CLIENT_UA = {
  ANDROID: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
  IOS: 'com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X)',
};

function get(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, headers, timeoutMs));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

// One 4MB slice, retried on its own. A whole-file restart on a single dropped
// chunk would throw away everything already fetched.
async function fetchChunk(url, start, end, ua, onBytes) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const buf = await get(url + '&range=' + start + '-' + end, {
        'User-Agent': ua,
        // Sent as well as the range parameter: googlevideo honours either, and
        // some edges ignore the query form.
        Range: 'bytes=' + start + '-' + end,
      }, 90000);
      onBytes(buf.length);
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}

// Fetch one stream to `dest`, reporting cumulative bytes as it goes.
//
// Two implementations. The native engine is the one worth having; the buffered
// one below is what shipped and stays as the fallback for any install where the
// DLL is missing or switched off.
//
// `onNative` receives the live engine handle so the caller can cancel a job that
// is actually running, instead of setting a flag the loop checks between 4MB
// chunks.
async function downloadStream(url, total, dest, ua, connections, isCancelled, onProgress, opts = {}) {
  const binDir = opts.binDir || defaultBinDir();
  if (engine.enabled(binDir)) {
    return nativeStream(url, total, dest, ua, binDir, onProgress, opts.onNative, opts.onConnections || (() => {}));
  }
  return bufferedStream(url, total, dest, ua, connections, isCancelled, onProgress);
}

// googlevideo accepts the range as a query parameter as well as a header, and
// the buffered path has always sent both — its own note says "some edges ignore
// the query form", meaning the header is the reliable one and the parameter is
// belt and braces. This path is not yet proven against YouTube, so it wears the
// same belt.
function isGoogleVideo(url) {
  try {
    return /(^|\.)googlevideo\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function nativeStream(url, total, dest, ua, binDir, onProgress, onNative, onConnections) {
  return new Promise((resolve, reject) => {
    const handle = engine.startDirectDownload({
      url,
      output: dest,
      // The CDN checks the user agent still matches the client the URL was
      // issued to; see CLIENT_UA above.
      headers: { 'User-Agent': ua },
      expectedBytes: total,
      rangeQuery: isGoogleVideo(url),
      // Nothing to continue: each run gets its own mkdtemp folder.
      resume: false,
    }, { binDir });

    if (!handle) {
      reject(new Error('engine unavailable'));
      return;
    }
    if (onNative) onNative(handle);

    handle.on('progress', (d) => {
      if (d.connections) onConnections(d.connections);
      if (typeof d.bytes === 'number') onProgress(d.bytes);
    });
    handle.on('done', (d) => {
      if (onNative) onNative(null);
      if (d.ok) return resolve(dest);
      reject(new Error(d.cancelled ? 'cancelled' : (d.error || 'download failed')));
    });
  });
}

// The original. Holds every chunk in memory and concatenates at the end, which
// means a 3GB stream needs 3GB twice over regardless of free disk — the reason
// the native path exists.
async function bufferedStream(url, total, dest, ua, connections, isCancelled, onProgress) {
  const ranges = [];
  for (let s = 0; s < total; s += CHUNK) ranges.push([s, Math.min(s + CHUNK - 1, total - 1)]);

  const buffers = new Array(ranges.length);
  let done = 0;
  let next = 0;

  const worker = async () => {
    for (;;) {
      if (isCancelled()) return;
      const i = next++;
      if (i >= ranges.length) return;
      buffers[i] = await fetchChunk(url, ranges[i][0], ranges[i][1], ua, (n) => {
        done += n;
        onProgress(done);
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(connections, ranges.length) }, worker));
  if (isCancelled()) return null;
  // Written in order, not as they arrive, so the file is correct regardless of
  // which connection finished first.
  await fs.promises.writeFile(dest, Buffer.concat(buffers.map((b) => b || Buffer.alloc(0))));
  return dest;
}

function runFfmpeg(args, binDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveBinary('ffmpeg', binDir), args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(err.split('\n').slice(-6).join(' ').slice(0, 300)));
    });
  });
}

// Put the video and audio tracks into one MP4.
//
// The native muxer does this in-process, and measured 21ms against ffmpeg's
// 92ms on a 12-second clip. It is a track copy only: it refuses any codec it
// would have to guess at rather than write a file that is quietly wrong, and
// ffmpeg picks up whatever it turns down. Audio-only jobs never come here —
// converting to mp3 needs an encoder, which is ffmpeg's job by definition.
async function mergeTracks(videoFile, audioFile, outPath, binDir, log) {
  if (engine.enabled(binDir)) {
    try {
      await engine.mux({ video: videoFile, audio: audioFile || '', output: outPath }, { binDir });
      return 'native';
    } catch (e) {
      // Expected for VP9/AV1/H265. Worth a line in the log because it explains
      // why one download took longer than another, but it is not an error.
      log(`Merging with ffmpeg (${e.message}).`);
    }
  }

  if (audioFile) {
    // -c copy: the streams already carry the container's codecs, so this is a
    // remux and costs seconds rather than a re-encode.
    await runFfmpeg(['-y', '-i', videoFile, '-i', audioFile, '-c', 'copy', '-movflags', '+faststart', outPath], binDir);
  } else {
    await runFfmpeg(['-y', '-i', videoFile, '-c', 'copy', outPath], binDir);
  }
  return 'ffmpeg';
}

function safeName(name) {
  return String(name || 'video')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'video';
}

// Mirrors startDownload's event shape so callers can treat the two the same:
//   'progress' -> { percent, size, speed, eta }
//   'log'      -> { message }
//   'done'     -> { ok, file, error, cancelled }
function startDirectDownload(job, opts = {}) {
  const emitter = new EventEmitter();
  const binDir = opts.binDir || defaultBinDir();
  const connections = Math.max(1, Math.min(16, opts.connections || DEFAULT_CONNECTIONS));
  const ua = CLIENT_UA[job.client] || CLIENT_UA.ANDROID;
  let cancelled = false;
  const isCancelled = () => cancelled;
  // The engine job currently running, when the native path is in use. The
  // buffered path has no such handle and leaves this null.
  let native = null;
  // Mirrored out of the engine's progress so report() can pass it on.
  let liveConnections = 0;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

  (async () => {
    try {
      const videoBytes = Number(job.video && job.video.contentLength) || 0;
      const audioBytes = Number(job.audio && job.audio.contentLength) || 0;
      const grand = videoBytes + audioBytes;
      let vDone = 0;
      let aDone = 0;
      const started = Date.now();

      const report = () => {
        const got = vDone + aDone;
        const secs = (Date.now() - started) / 1000;
        const rate = secs > 0 ? got / secs : 0;
        emitter.emit('progress', {
          percent: grand ? Math.min(99, (got / grand) * 100) : 0,
          size: grand ? (grand / 1048576).toFixed(1) + 'MiB' : '',
          speed: rate ? (rate / 1048576).toFixed(2) + 'MiB/s' : '',
          eta: rate && grand ? Math.max(0, Math.round((grand - got) / rate)) + 's' : '',
          // Percentages are totalled here across the video and audio streams,
          // so the engine's own progress cannot simply be forwarded. The live
          // connection count is not a total though, and it is the number that
          // explains a download getting faster halfway through.
          connections: liveConnections || undefined,
        });
      };

      emitter.emit('log', {
        message: 'Using your signed-in YouTube session' + (job.video.qualityLabel ? ' (' + job.video.qualityLabel + ')' : '') + '.',
      });

      const streamOpts = {
        binDir,
        onNative: (h) => { native = h; },
        onConnections: (n) => { liveConnections = n; },
      };

      const videoFile = path.join(tmp, 'v.bin');
      await downloadStream(job.video.url, videoBytes, videoFile, ua, connections, isCancelled, (n) => { vDone = n; report(); }, streamOpts);
      if (cancelled) throw new Error('cancelled');

      let audioFile = null;
      if (job.audio) {
        audioFile = path.join(tmp, 'a.bin');
        await downloadStream(job.audio.url, audioBytes, audioFile, ua, connections, isCancelled, (n) => { aDone = n; report(); }, streamOpts);
      }
      if (cancelled) throw new Error('cancelled');

      const isAudio = job.mode === 'audio';
      const ext = isAudio ? (job.aFormat || 'mp3') : 'mp4';
      const outPath = path.join(job.folder, safeName(job.title) + ' [' + job.videoId + '].' + ext);
      fs.mkdirSync(job.folder, { recursive: true });

      emitter.emit('log', { message: isAudio ? 'Converting audio.' : 'Merging video and audio.' });
      if (isAudio) {
        // Always ffmpeg: this re-encodes, and the engine has no encoder.
        await runFfmpeg(['-y', '-i', audioFile || videoFile, '-vn', outPath], binDir);
      } else {
        await mergeTracks(videoFile, audioFile, outPath, binDir,
          (message) => emitter.emit('log', { message }));
      }

      cleanup();
      emitter.emit('progress', { percent: 100 });
      emitter.emit('done', { ok: true, file: outPath, percent: 100 });
    } catch (e) {
      cleanup();
      if (cancelled) emitter.emit('done', { ok: false, cancelled: true });
      else emitter.emit('done', { ok: false, error: (e && e.message) || 'download failed' });
    }
  })();

  // Setting the flag is enough for the buffered path, which checks it between
  // chunks. The native path is a running job and has to be told, or a cancel
  // would not take effect until the current 8MB range finished.
  const stop = () => {
    cancelled = true;
    if (native) {
      try { native.cancel(); } catch {}
    }
  };
  emitter.cancel = stop;
  emitter.killSilently = stop;
  return emitter;
}

module.exports = { startDirectDownload, CLIENT_UA };
