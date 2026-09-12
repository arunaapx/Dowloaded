// Host binding for velox_engine.dll — Phase 0 of the native engine.
//
// This module is the ONLY thing in the app that knows the DLL exists. It hands
// back the same EventEmitter shape core/downloader.js has always returned
// (progress/log/done, .cancel(), .killSilently(), .pid), so a caller cannot
// tell which engine served it.
//
// Everything here degrades to "not available" rather than throwing: a missing
// koffi, a missing DLL, an ABI mismatch — all of them just mean the app keeps
// spawning yt-dlp the way it does today. Nothing about this module is on the
// critical path until VELOX_ENGINE=1 is set.
//
// Events are POLLED, not delivered by callback. koffi runs a JS callback on
// whichever thread calls it, and the engine reads download output on worker
// threads; a callback design would touch V8 off Node's main thread, which
// crashes the process instead of failing. See engine/src/engine.rs.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// ---------- DLL discovery ----------

function dllFileName() {
  if (process.platform === 'win32') return 'velox_engine.dll';
  if (process.platform === 'darwin') return 'libvelox_engine.dylib';
  return 'libvelox_engine.so';
}

// In order: an explicit override, the folder the app ships binaries from, then
// the cargo output — so a developer who just ran `npm run engine:build` gets the
// build they made without copying it anywhere.
function candidatePaths(binDir) {
  const file = dllFileName();
  const list = [];
  if (process.env.VELOX_ENGINE_DLL) list.push(process.env.VELOX_ENGINE_DLL);
  if (binDir) list.push(path.join(binDir, file));
  list.push(path.join(__dirname, '..', 'bin', file));
  list.push(path.join(__dirname, '..', 'engine', 'target', 'release', file));
  list.push(path.join(__dirname, '..', 'engine', 'target', 'debug', file));
  return list;
}

function findDll(binDir) {
  for (const p of candidatePaths(binDir)) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return '';
}

// ---------- library loading ----------

let lib = null;          // { koffi, fns, path } once loaded
let loadError = '';      // why it is unavailable, for diagnostics

function loadLibrary(binDir) {
  if (lib) return lib;
  if (loadError) return null; // don't retry a known-bad load on every call

  let koffi;
  try {
    koffi = require('koffi');
  } catch (e) {
    loadError = `koffi is not installed: ${e.message}`;
    return null;
  }

  const dllPath = findDll(binDir);
  if (!dllPath) {
    loadError = `no ${dllFileName()} found (looked in bin/ and engine/target/)`;
    return null;
  }

  try {
    const native = koffi.load(dllPath);

    // Opaque handle: koffi keeps the pointer intact instead of marshalling it.
    koffi.opaque('VxEngine');

    // Strings the engine allocates are owned by us. A disposable type frees
    // them the moment koffi has copied the bytes into a JS string, so no call
    // site can leak one by forgetting.
    const vxStringFree = native.func('void vx_string_free(void* s)');
    koffi.disposable('VxStr', 'str', vxStringFree);

    const fns = {
      version: native.func('const char* vx_version()'),
      engineNew: native.func('VxEngine* vx_engine_new(const char* config_json)'),
      engineFree: native.func('void vx_engine_free(VxEngine* engine)'),
      lastError: native.func('int32_t vx_last_error(VxEngine* engine, _Out_ VxStr* out)'),
      describe: native.func('int32_t vx_describe(VxEngine* engine, _Out_ VxStr* out)'),
      probe: native.func('int32_t vx_probe(VxEngine* engine, const char* url, const char* opts, _Out_ VxStr* out)'),
      download: native.func('int64_t vx_download(VxEngine* engine, const char* job_json)'),
      cancel: native.func('int32_t vx_cancel(VxEngine* engine, int64_t job)'),
      pause: native.func('int32_t vx_pause(VxEngine* engine, int64_t job)'),
      jobStatus: native.func('int32_t vx_job_status(VxEngine* engine, int64_t job, _Out_ VxStr* out)'),
      poll: native.func('int32_t vx_poll(VxEngine* engine, int32_t max, _Out_ VxStr* out)'),
      mux: native.func('int32_t vx_mux(VxEngine* engine, const char* spec_json)'),
    };

    lib = { koffi, fns, path: dllPath, version: fns.version() };
    return lib;
  } catch (e) {
    loadError = `could not bind ${dllPath}: ${e.message}`;
    return null;
  }
}

// ---------- engine handles ----------

// One engine per bin directory. In the desktop app there is exactly one; the
// web server may serve a different VELOX_BIN_DIR, so it is keyed rather than
// assumed.
const engines = new Map();

// Deliberately duplicated from core/downloader.js rather than imported:
// downloader.js requires this module, and a cycle would leave one of them
// holding a half-built export object. It is two lines, and they must agree —
// if they drift, a caller that omits binDir gets a second engine handle that
// resolves different binaries than the one the app is using.
function defaultBinDir() {
  return process.env.VELOX_BIN_DIR || path.join(__dirname, '..', 'bin');
}

function getEngine(binDir) {
  // Normalise before keying, so status() with no argument and enabled(binDir)
  // from the downloader land on the same handle instead of building two.
  const key = binDir || defaultBinDir();
  const existing = engines.get(key);
  if (existing) return existing;

  const l = loadLibrary(key);
  if (!l) return null;

  const handle = l.fns.engineNew(JSON.stringify({
    binDir: key,
    probeTimeoutMs: Number(process.env.VELOX_PROBE_TIMEOUT_MS) || 60000,
  }));
  if (!handle) {
    loadError = 'vx_engine_new rejected the config';
    return null;
  }

  const eng = { handle, lib: l, jobs: new Map(), poller: null };
  engines.set(key, eng);
  return eng;
}

function lastError(eng) {
  const out = [null];
  eng.lib.fns.lastError(eng.handle, out);
  return out[0] || '';
}

// ---------- availability ----------

/// True when the DLL is present and bindable. Never throws.
function isAvailable(binDir) {
  return !!getEngine(binDir);
}

/// Phase 0 is opt-in: the engine is only used when VELOX_ENGINE=1 AND it loads.
/// Everything ships with it off, so a broken build cannot break a release.
function enabled(binDir) {
  if (String(process.env.VELOX_ENGINE || '') !== '1') return false;
  return isAvailable(binDir);
}

/// Diagnostics for a preflight/about screen.
function status(binDir) {
  const eng = getEngine(binDir);
  if (!eng) return { available: false, enabled: false, error: loadError };
  const out = [null];
  eng.lib.fns.describe(eng.handle, out);
  let described = {};
  try { described = JSON.parse(out[0] || '{}'); } catch {}
  return {
    available: true,
    enabled: enabled(binDir),
    dll: eng.lib.path,
    version: eng.lib.version,
    ...described,
  };
}

// ---------- probe ----------

// A probe blocks a libuv worker for as long as yt-dlp takes. libuv's pool is
// four threads by default and the same pool serves fs and DNS, so probes are
// queued rather than fired all at once — otherwise pasting a playlist of links
// would stall unrelated file writes.
const MAX_INFLIGHT_PROBES = 2;
let inflightProbes = 0;
const probeQueue = [];

function pumpProbes() {
  while (inflightProbes < MAX_INFLIGHT_PROBES && probeQueue.length) {
    const task = probeQueue.shift();
    inflightProbes += 1;
    task(() => {
      inflightProbes -= 1;
      pumpProbes();
    });
  }
}

/**
 * Resolve a URL to metadata plus a format list.
 *
 * Resolves to the normalised object documented in engine/include/velox_engine.h
 * — the engine's own shape, not yt-dlp's, so callers survive Phase 2.
 * Rejects with an Error carrying `.code` (a VX_ERR_* number) on failure.
 */
function probe(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const eng = getEngine(opts.binDir);
    if (!eng) {
      reject(Object.assign(new Error(loadError || 'engine unavailable'), { code: -1 }));
      return;
    }
    const payload = JSON.stringify({
      args: opts.args || [],
      playlist: !!opts.playlist,
      includeRaw: !!opts.includeRaw,
      timeoutMs: Number(opts.timeoutMs) || 0,
    });

    probeQueue.push((doneWithSlot) => {
      const out = [null];
      eng.lib.fns.probe.async(eng.handle, url, payload, out, (err, rc) => {
        doneWithSlot();
        if (err) {
          reject(Object.assign(new Error(err.message), { code: -1 }));
          return;
        }
        if (rc !== 0) {
          reject(Object.assign(new Error(lastError(eng) || `probe failed (${rc})`), { code: rc }));
          return;
        }
        try {
          resolve(JSON.parse(out[0] || '{}'));
        } catch (e) {
          reject(Object.assign(new Error(`probe returned bad JSON: ${e.message}`), { code: -4 }));
        }
      });
    });
    pumpProbes();
  });
}

// ---------- mux ----------

/**
 * Copy a video track and an audio track into one MP4 without re-encoding —
 * the `-c copy` case, done in-process instead of by ffmpeg.
 *
 * spec: { video, audio, output }. An empty `audio` rewrites the video file into
 * a fresh container on its own.
 *
 * REJECTS on any codec it cannot carry (VP9, AV1, H265) and on anything needing
 * a real encoder. That is the contract, not a shortcoming: the caller is
 * expected to fall back to ffmpeg, and an honest refusal is worth more than a
 * file that is silently wrong.
 */
function mux(spec, options = {}) {
  return new Promise((resolve, reject) => {
    const eng = getEngine(options.binDir);
    if (!eng) {
      reject(Object.assign(new Error(loadError || 'engine unavailable'), { code: -1 }));
      return;
    }
    // Async: muxing a 4GB file walks every sample, and doing that on the main
    // thread would freeze the window for the whole of it.
    eng.lib.fns.mux.async(eng.handle, JSON.stringify({
      video: spec.video || '',
      audio: spec.audio || '',
      output: spec.output || '',
    }), (err, rc) => {
      if (err) return reject(Object.assign(new Error(err.message), { code: -1 }));
      if (rc !== 0) return reject(Object.assign(new Error(lastError(eng) || `mux failed (${rc})`), { code: rc }));
      resolve(spec.output);
    });
  });
}

// ---------- event pump ----------

const POLL_INTERVAL_MS = Number(process.env.VELOX_ENGINE_POLL_MS) || 100;

function startPolling(eng) {
  if (eng.poller) return;
  // Deliberately NOT unref'd. This timer is the only handle the engine route
  // keeps, so unref-ing it lets Node exit the moment startDownload returns —
  // measured: the download began, the process ended, and no done event ever
  // arrived. The subprocess route stays alive on its child handle and never
  // showed this. stopPolling clears the timer as soon as the last job settles,
  // so it cannot hold the process open past the work either.
  eng.poller = setInterval(() => drain(eng), POLL_INTERVAL_MS);
}

function stopPolling(eng) {
  if (eng.poller && eng.jobs.size === 0) {
    clearInterval(eng.poller);
    eng.poller = null;
  }
}

function drain(eng) {
  const out = [null];
  const n = eng.lib.fns.poll(eng.handle, 0, out);
  if (n <= 0) {
    stopPolling(eng);
    return;
  }
  let events = [];
  try {
    events = JSON.parse(out[0] || '[]');
  } catch {
    return;
  }
  for (const ev of events) dispatch(eng, ev);
  stopPolling(eng);
}

function dispatch(eng, ev) {
  const entry = eng.jobs.get(ev.job);
  if (!entry) return;
  const { emitter } = entry;

  switch (ev.type) {
    case 'started':
      emitter.pid = ev.pid;
      break;

    case 'progress':
      // The engine speaks `pct`; the app has always spoken `percent`.
      emitter.emit('progress', {
        percent: ev.pct,
        size: ev.size || '',
        speed: ev.speed || '',
        eta: ev.eta || '',
        // Native path only. The number the controller is moving, and the one
        // worth showing a user who asks why a download sped up mid-file.
        connections: ev.connections,
        // The same facts as numbers. A caller totalling two streams into one
        // percentage cannot do arithmetic on the display strings above.
        bytes: ev.bytes,
        total: ev.total,
        bps: ev.bps,
      });
      break;

    case 'file':
      entry.file = ev.path;
      if (!ev.quiet) emitter.emit('log', { message: `→ ${path.basename(ev.path)}` });
      break;

    case 'stage':
      emitter.emit('log', { message: STAGE_TEXT[ev.stage] || ev.stage });
      break;

    case 'log':
      emitter.emit('log', { message: ev.message, error: !!ev.error });
      break;

    case 'paused':
      // killSilently(): the caller is showing this as paused and is not waiting
      // on a done. Retire the job without emitting anything, exactly as the
      // subprocess path does when it removes its own close listener.
      eng.jobs.delete(ev.job);
      break;

    case 'done':
      eng.jobs.delete(ev.job);
      emitter.emit('done', {
        ok: ev.ok,
        code: ev.code,
        file: ev.file || entry.file || '',
        percent: ev.pct,
        error: ev.error || '',
        cancelled: !!ev.cancelled,
      });
      break;

    default:
      break;
  }
}

const STAGE_TEXT = {
  merge: 'Merging audio + video…',
  'extract-audio': 'Extracting audio…',
  remux: 'Remuxing for playback compatibility…',
  convert: 'Converting to a compatible MP4…',
};

// ---------- download ----------

/**
 * Start a download through the engine.
 *
 * `args` is the yt-dlp argument vector the host built — in Phase 0 format
 * selection still belongs to core/downloader.js's buildArgs(), so the engine
 * runs precisely what the app would have run itself. Phase 1 replaces this with
 * a typed job description.
 *
 * Returns an EventEmitter with the same contract as core/downloader.js:
 *   'progress' -> { percent, size, speed, eta }
 *   'log'      -> { message, error? }
 *   'done'     -> { ok, code, file, percent, error, cancelled }
 *   .cancel()        kill and emit a cancelled done
 *   .killSilently()  kill and emit nothing (the pause path)
 *   .pid             filled in as soon as the engine reports it
 *
 * Returns null when the engine is unavailable, so the caller can fall through
 * to the subprocess path.
 */
function startDownload(args, options = {}) {
  const eng = getEngine(options.binDir);
  if (!eng) return null;
  return submit(eng, { args, url: options.url || '' });
}

/**
 * Download an ALREADY-RESOLVED media URL with the engine's own HTTP stack.
 *
 * This is the native path: no yt-dlp, no subprocess. It opens as many ranged
 * connections as the host actually rewards and keeps adjusting while it runs,
 * which is what gets past a server that caps a single connection.
 *
 * spec: { url, output, headers, expectedBytes, maxConnections, proxy, resume }
 *
 * `output` is the final path. While it runs the bytes live in
 * `<output>.velox-part` with a small JSON sidecar beside it, so an interrupted
 * download resumes instead of starting over. Returns the same EventEmitter as
 * every other path, or null when the engine is unavailable.
 */
function startDirectDownload(spec, options = {}) {
  const eng = getEngine(options.binDir);
  if (!eng) return null;
  return submit(eng, { direct: spec, url: spec.url || '' });
}

function submit(eng, payload) {
  const emitter = new EventEmitter();
  const id = eng.lib.fns.download(eng.handle, JSON.stringify(payload));

  // Negative ids are VX_ERR_* codes, not jobs.
  const jobId = typeof id === 'bigint' ? Number(id) : id;
  if (!(jobId > 0)) {
    const message = lastError(eng) || `engine refused the job (${jobId})`;
    // Report it as a normal failed download rather than throwing: the caller is
    // mid-UI-update and a throw here would be a different code path to test.
    process.nextTick(() => {
      emitter.emit('log', { message, error: true });
      emitter.emit('done', { ok: false, code: jobId, file: '', percent: 0, error: message });
    });
    emitter.cancel = () => {};
    emitter.killSilently = () => {};
    return emitter;
  }

  eng.jobs.set(jobId, { emitter, file: '' });
  startPolling(eng);

  emitter.jobId = jobId;
  emitter.pid = 0;
  emitter.cancel = () => {
    eng.lib.fns.cancel(eng.handle, jobId);
    // The done event follows from the engine once the child actually exits, so
    // nothing is emitted here.
  };
  emitter.killSilently = () => {
    eng.lib.fns.pause(eng.handle, jobId);
  };

  return emitter;
}

// ---------- shutdown ----------

/// Kill every live job and release the handles. Safe to call twice.
function shutdown() {
  for (const [key, eng] of engines) {
    try {
      if (eng.poller) clearInterval(eng.poller);
      eng.lib.fns.engineFree(eng.handle);
    } catch {}
    engines.delete(key);
  }
}

// An engine handle left alive past process exit would leave yt-dlp children
// running with no parent watching them.
process.once('exit', shutdown);

module.exports = {
  isAvailable,
  enabled,
  status,
  probe,
  startDownload,
  startDirectDownload,
  mux,
  shutdown,
};
