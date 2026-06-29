// Server-side download job manager for the web app.
//
// Each job runs the shared core downloader (core/downloader.js) into its own
// temp folder on the VPS, buffers progress, and exposes events over an
// EventEmitter so the HTTP layer can stream them to the browser via SSE.
//
// A small queue caps how many yt-dlp/ffmpeg processes run at once so the VPS
// doesn't fall over, and finished jobs are cleaned off disk after a TTL.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { startDownload } = require('../core/downloader');

const TMP_ROOT = process.env.VELOX_TMP_DIR || path.join(__dirname, 'tmp');
const JOB_TTL_MS = parseInt(process.env.VELOX_JOB_TTL_MIN || '60', 10) * 60 * 1000;
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.VELOX_MAX_CONCURRENT || '2', 10));
// Hard cap on a single download's wall-clock time, and a stall guard that kills
// a job if it makes no progress for too long — so a hung yt-dlp can never hold
// a concurrency slot forever.
const JOB_TIMEOUT_MS = parseInt(process.env.VELOX_JOB_TIMEOUT_MIN || '30', 10) * 60 * 1000;
const STALL_TIMEOUT_MS = parseInt(process.env.VELOX_STALL_TIMEOUT_SEC || '120', 10) * 1000;
// Refuse new jobs once this many are queued/running, instead of growing forever.
const MAX_QUEUE = Math.max(MAX_CONCURRENT, parseInt(process.env.VELOX_MAX_QUEUE || '20', 10));
// yt-dlp's own network guards (let it fail dead hosts before our watchdog has to).
const SOCKET_TIMEOUT = Math.max(1, parseInt(process.env.VELOX_SOCKET_TIMEOUT_SEC || '20', 10));
const DL_RETRIES = Math.max(0, parseInt(process.env.VELOX_DL_RETRIES || '2', 10));

fs.mkdirSync(TMP_ROOT, { recursive: true });

const jobs = new Map();   // id -> job
const queue = [];         // jobs waiting for a slot
let running = 0;

function newId() {
  return crypto.randomBytes(9).toString('hex');
}

function snapshot(job) {
  return {
    id: job.id,
    status: job.status,
    percent: job.percent,
    size: job.size,
    speed: job.speed,
    eta: job.eta,
    error: job.error,
    filename: job.file ? path.basename(job.file) : null,
  };
}

function createJob(payload) {
  // Back-pressure: don't let the queue grow without bound.
  if (running + queue.length >= MAX_QUEUE) {
    return { full: true };
  }
  const id = newId();
  const dir = path.join(TMP_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    id,
    payload,
    dir,
    bus: new EventEmitter(),
    status: 'queued',          // queued | running | done | error
    percent: 0,
    size: '',
    speed: '',
    eta: '',
    logs: [],
    file: null,
    error: null,
    handle: null,
    createdAt: Date.now(),
  };
  // Allow many SSE listeners on one job without Node's warning.
  job.bus.setMaxListeners(50);
  jobs.set(id, job);

  queue.push(job);
  pump();
  return job;
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    runJob(queue.shift());
  }
}

function runJob(job) {
  running += 1;
  job.status = 'running';
  job.bus.emit('update', snapshot(job));

  // Watchdogs: a hard ceiling on total time, plus a stall guard reset on every
  // bit of output. Either firing kills the process and frees the slot.
  job.killReason = null;
  const fail = (reason) => {
    if (!job.handle) return;
    job.killReason = reason;
    job.handle.cancel();
  };
  const hardTimer = setTimeout(() => fail('timed out (exceeded max duration)'), JOB_TIMEOUT_MS);
  let stallTimer;
  const bumpStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => fail('stalled (no progress)'), STALL_TIMEOUT_MS);
  };
  bumpStall();
  const clearTimers = () => { clearTimeout(hardTimer); clearTimeout(stallTimer); };

  // Cap the title at 80 chars in the template — long titles (emoji/hashtag walls)
  // otherwise blow past the Windows 260-char path limit AND the 255-byte
  // per-component limit on Linux, failing with [Errno 22]. --trim-filenames is
  // unreliable, so we bound it here directly.
  const outputTemplate = path.join(job.dir, '%(title).80s [%(id)s].%(ext)s');
  const handle = startDownload({
    socketTimeout: SOCKET_TIMEOUT,
    maxRetries: DL_RETRIES,
    ...job.payload,            // explicit payload values win over defaults
    folder: job.dir,
    outputTemplate,
  });
  job.handle = handle;

  handle.on('progress', (d) => {
    bumpStall();
    if (typeof d.percent === 'number') job.percent = d.percent;
    if (d.size) job.size = d.size;
    job.speed = d.speed || '';
    job.eta = d.eta || '';
    job.bus.emit('update', snapshot(job));
  });

  handle.on('log', (d) => {
    bumpStall();
    job.logs.push(d.message);
    if (job.logs.length > 200) job.logs.shift();
    job.bus.emit('log', d);
  });

  handle.on('done', (d) => {
    clearTimers();
    running -= 1;
    job.handle = null;
    if (job.killReason) {
      job.status = 'error';
      job.error = job.killReason;
      const snap = snapshot(job);
      job.bus.emit('update', snap);
      job.bus.emit('end', snap);
      pump();
      scheduleCleanup(job, 5000);
      return;
    }
    if (d.ok) {
      job.status = 'done';
      job.percent = 100;
      job.file = resolveOutputFile(job, d.file);
      if (!job.file) { job.status = 'error'; job.error = 'output file missing'; }
    } else {
      job.status = 'error';
      job.error = d.error || 'download failed';
    }
    const snap = snapshot(job);
    job.bus.emit('update', snap);
    job.bus.emit('end', snap);
    pump();
    scheduleCleanup(job);
  });
}

// yt-dlp's reported destination can differ from the final file (merge/recode),
// so fall back to the largest finished file in the job folder.
function resolveOutputFile(job, reported) {
  try {
    if (reported && fs.existsSync(reported)) return reported;
    const files = fs.readdirSync(job.dir)
      .map((f) => path.join(job.dir, f))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
      .filter((p) => !/\.(?:part|ytdl|temp)$/i.test(p))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return files[0] || null;
  } catch {
    return null;
  }
}

function getJob(id) {
  return jobs.get(id);
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  const qi = queue.indexOf(job);
  if (qi >= 0) queue.splice(qi, 1);
  if (job.handle) job.handle.cancel();
  job.status = 'error';
  job.error = 'cancelled';
  job.bus.emit('end', snapshot(job));
  scheduleCleanup(job, 5000);
  return true;
}

function scheduleCleanup(job, delay = JOB_TTL_MS) {
  const t = setTimeout(() => {
    try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
    jobs.delete(job.id);
  }, delay);
  if (t.unref) t.unref();
}

// Sweep any orphan temp folders left by a previous crash.
function sweepOrphans() {
  try {
    for (const name of fs.readdirSync(TMP_ROOT)) {
      if (!jobs.has(name)) {
        try { fs.rmSync(path.join(TMP_ROOT, name), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}
sweepOrphans();

module.exports = { createJob, getJob, cancelJob, snapshot, MAX_CONCURRENT };
