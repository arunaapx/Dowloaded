// Client-side download engine (thin-client model).
//
// The server (core/extractor.js) hands back direct CDN stream URLs. THIS module
// runs on the user's device and pulls those bytes with the device's own
// bandwidth, then merges/converts with the bundled ffmpeg. No yt-dlp here — a
// cracked client still can't extract; it can only fetch URLs the licensed server
// already resolved.
//
// Design: network bytes are pulled with Node's http(s) (reliable, redirect-
// following, clean byte progress). ffmpeg only ever touches LOCAL files (merge /
// convert / remux) — never the network — which avoids ffmpeg's flaky-CDN
// "stream ends prematurely" truncation. HLS/DASH (.m3u8/.mpd) is the one case
// ffmpeg must fetch directly.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { resolveBinary, defaultBinDir } = require('./downloader');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function sanitizeName(name) {
  return String(name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'video';
}

function isHls(u) {
  return /\.m3u8(?:[?#]|$)/i.test(u) || /\.mpd(?:[?#]|$)/i.test(u);
}

function timeToSeconds(t) {
  const m = String(t).match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
}

function audioCodecArgs(ext) {
  switch (ext) {
    case 'mp3': return ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'];
    case 'm4a': return ['-vn', '-c:a', 'aac', '-b:a', '192k'];
    case 'opus': return ['-vn', '-c:a', 'libopus', '-b:a', '160k'];
    case 'flac': return ['-vn', '-c:a', 'flac'];
    default: return ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'];
  }
}

const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB ranges

// Open a single ranged GET, following redirects. Resolves with the live response.
function openRange(url, start, end, opts, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const headers = { 'User-Agent': USER_AGENT, Range: `bytes=${start}-${end}` };
    if (opts.headers && opts.headers.Referer) headers.Referer = opts.headers.Referer;

    const req = lib.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects > 8) return reject(new Error('too many redirects'));
        return resolve(openRange(new URL(res.headers.location, url).toString(), start, end, opts, redirects + 1));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve({ url, req, res });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 30000, () => req.destroy(new Error('connection timed out')));
  });
}

// Download a URL to a file in sequential 10MB ranges. Chunked range requests
// stop YouTube (and similar CDNs) from throttling a single long-lived GET to a
// crawl — this is what makes downloads fast. Follows redirects, sends Referer.
function httpDownload(url, dest, opts = {}) {
  return new Promise((resolve, reject) => {
    const state = { aborted: false, req: null };
    const out = fs.createWriteStream(dest);

    if (opts.registerAbort) opts.registerAbort(() => {
      state.aborted = true;
      try { state.req && state.req.destroy(); } catch {}
      try { out.destroy(); } catch {}
      try { fs.unlinkSync(dest); } catch {}
    });

    let start = 0;
    let total = null;
    let received = 0;
    let currentUrl = url;

    const fail = (e) => { try { out.destroy(); } catch {}; reject(e); };

    const pump = () => {
      if (state.aborted) return fail(new Error('cancelled'));
      const end = total != null ? Math.min(start + CHUNK_SIZE - 1, total - 1) : start + CHUNK_SIZE - 1;

      openRange(currentUrl, start, end, opts).then(({ url: u, req, res }) => {
        currentUrl = u;
        state.req = req;

        if (total == null) {
          const cr = res.headers['content-range']; // "bytes 0-N/TOTAL"
          const m = cr && cr.match(/\/(\d+)\s*$/);
          if (m) total = parseInt(m[1], 10);
          else if (res.statusCode === 200 && res.headers['content-length']) total = parseInt(res.headers['content-length'], 10);
        }
        const full = res.statusCode === 200; // server ignored Range → whole file in one go

        res.on('data', (c) => { received += c.length; opts.onProgress && opts.onProgress(received, total || 0); });
        res.pipe(out, { end: false });
        res.on('error', fail);
        res.on('end', () => {
          if (state.aborted) return fail(new Error('cancelled'));
          if (full || total == null || (total != null && received >= total)) {
            out.end(() => resolve({ received, total }));
            return;
          }
          start = end + 1;
          pump();
        });
      }).catch(fail);
    };

    pump();
  });
}

// Run ffmpeg on LOCAL input files (merge / convert / remux). Reliable: no network.
function ffmpegLocal(ffmpeg, inputs, outFile, codecArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1'];
    for (const f of inputs) args.push('-i', f);
    args.push(...codecArgs, outFile);

    const proc = spawn(ffmpeg, args, { windowsHide: true });
    if (opts.registerProc) opts.registerProc(proc);
    let err = '';
    proc.stdout.on('data', (d) => {
      d.toString().split(/\r?\n/).forEach((line) => {
        const t = line.match(/^out_time=(.+)$/);
        if (t && opts.onTime) { const s = timeToSeconds(t[1].trim()); if (s != null) opts.onTime(s); }
      });
    });
    proc.stderr.on('data', (d) => { err = `${err}\n${d.toString()}`.slice(-2000); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
}

// Fetch via ffmpeg directly — only for HLS/DASH, which Node can't trivially pull.
function ffmpegFetch(ffmpeg, spec, outFile, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1'];
    const robustness = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5'];
    const hdr = spec.headers && spec.headers.Referer ? ['-headers', `Referer: ${spec.headers.Referer}\r\n`] : [];
    for (const url of spec.streams) { args.push(...robustness); if (hdr.length) args.push(...hdr); args.push('-i', url); }
    if (spec.mode === 'audio') args.push(...audioCodecArgs(spec.container || 'mp3'));
    else { if (spec.needsMerge && spec.streams.length >= 2) args.push('-map', '0:v:0', '-map', '1:a:0'); args.push('-c', 'copy', '-movflags', '+faststart'); }
    args.push(outFile);

    const proc = spawn(ffmpeg, args, { windowsHide: true });
    if (opts.registerProc) opts.registerProc(proc);
    let err = '';
    proc.stdout.on('data', (d) => {
      d.toString().split(/\r?\n/).forEach((line) => {
        const t = line.match(/^out_time=(.+)$/);
        if (t && opts.onTime) { const s = timeToSeconds(t[1].trim()); if (s != null) opts.onTime(s); }
      });
    });
    proc.stderr.on('data', (d) => { err = `${err}\n${d.toString()}`.slice(-2000); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (/stream ends prematurely|partial file|invalid data/i.test(err)) return reject(new Error('download was interrupted (incomplete)'));
      return code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}

// Orchestrate a full client download. Returns an EventEmitter:
//   'progress' -> { percent }
//   'log'      -> { message, error? }
//   'done'     -> { ok, file, error }
// plus .cancel() and .killSilently() (matching core/downloader's handle).
function startClientDownload(spec, options = {}) {
  const binDir = options.binDir || defaultBinDir();
  const ffmpeg = resolveBinary('ffmpeg', binDir);
  const emitter = new EventEmitter();

  const outExt = spec.mode === 'audio' ? (spec.container || 'mp3') : (spec.container || 'mp4');
  const outFile = path.join(spec.folder, `${sanitizeName(spec.filenameBase)}.${outExt}`);
  const duration = Number(spec.durationSec) > 0 ? Number(spec.durationSec) : 0;

  let cancelled = false;
  let silent = false;
  let abortDownload = null;
  let activeProc = null;
  const temps = [];

  const setProgress = (p) => emitter.emit('progress', { percent: Math.max(0, Math.min(100, Math.round(p))) });
  const log = (message, error) => emitter.emit('log', { message, error: !!error });

  const finish = (result) => {
    temps.forEach((t) => { try { fs.unlinkSync(t); } catch {} });
    if (silent) return;
    emitter.emit('done', result);
  };

  (async () => {
    try {
      fs.mkdirSync(spec.folder, { recursive: true });

      if (spec.streams.some(isHls)) {
        // HLS/DASH — ffmpeg must fetch.
        log('Downloading stream…');
        await ffmpegFetch(ffmpeg, spec, outFile, {
          registerProc: (p) => (activeProc = p),
          onTime: (s) => duration && setProgress((s / duration) * 100),
        });
      } else {
        // Pull each stream with Node http (download phase = 0–90%).
        for (let i = 0; i < spec.streams.length; i++) {
          const tmp = path.join(spec.folder, `.veloxtmp_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`);
          temps.push(tmp);
          const base = (i / spec.streams.length) * 90;
          const span = (1 / spec.streams.length) * 90;
          log(spec.streams.length > 1 ? (i === 0 ? 'Downloading video…' : 'Downloading audio…') : 'Downloading…');
          await httpDownload(spec.streams[i], tmp, {
            headers: spec.headers,
            registerAbort: (fn) => (abortDownload = fn),
            onProgress: (r, t) => { if (t) setProgress(base + (r / t) * span); },
          });
          if (cancelled) throw new Error('cancelled');
        }

        // Produce the final file with LOCAL ffmpeg (90–100%).
        log('Finalizing…');
        if (spec.mode === 'audio') {
          await ffmpegLocal(ffmpeg, [temps[0]], outFile, audioCodecArgs(outExt), {
            registerProc: (p) => (activeProc = p),
            onTime: (s) => duration && setProgress(90 + (s / duration) * 10),
          });
        } else if (spec.needsMerge && temps.length >= 2) {
          await ffmpegLocal(ffmpeg, temps, outFile, ['-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart'], {
            registerProc: (p) => (activeProc = p),
            onTime: (s) => duration && setProgress(90 + (s / duration) * 10),
          });
        } else {
          await ffmpegLocal(ffmpeg, [temps[0]], outFile, ['-c', 'copy', '-movflags', '+faststart'], {
            registerProc: (p) => (activeProc = p),
            onTime: (s) => duration && setProgress(90 + (s / duration) * 10),
          });
        }
      }

      if (cancelled) { try { fs.unlinkSync(outFile); } catch {} return finish({ ok: false, file: outFile, error: 'cancelled', cancelled: true }); }

      let size = 0;
      try { size = fs.statSync(outFile).size; } catch {}
      if (size < 1024) { try { fs.unlinkSync(outFile); } catch {} return finish({ ok: false, file: outFile, error: 'download produced an empty file' }); }

      setProgress(100);
      finish({ ok: true, file: outFile, percent: 100 });
    } catch (e) {
      try { fs.unlinkSync(outFile); } catch {}
      if (cancelled) return finish({ ok: false, file: outFile, error: 'cancelled', cancelled: true });
      finish({ ok: false, file: outFile, error: e.message });
    }
  })();

  const stop = () => {
    cancelled = true;
    if (abortDownload) try { abortDownload(); } catch {}
    if (activeProc) try { activeProc.kill(); } catch {}
  };
  emitter.cancel = stop;
  emitter.killSilently = () => { silent = true; stop(); };

  return emitter;
}

module.exports = { startClientDownload, sanitizeName, isHls };
