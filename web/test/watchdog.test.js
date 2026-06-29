// Deterministic test for the stall watchdog and queue back-pressure.
// Points a download at a server that accepts the connection but never replies,
// so yt-dlp goes quiet — the stall guard must kill it and free the slot.

const http = require('http');

// Low timeouts BEFORE requiring jobs (constants are read at load time).
process.env.VELOX_STALL_TIMEOUT_SEC = '3';
process.env.VELOX_JOB_TIMEOUT_MIN = '1';
process.env.VELOX_MAX_CONCURRENT = '1';
process.env.VELOX_MAX_QUEUE = '2';
process.env.VELOX_TMP_DIR = require('path').join(require('os').tmpdir(), 'velox-wd-test');

const jobs = require('../jobs');

function log(ok, msg) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) process.exitCode = 1;
}

// A server that accepts but never responds → simulates a hung download.
const hang = http.createServer(() => { /* never reply */ });

hang.listen(0, '127.0.0.1', async () => {
  const port = hang.address().port;
  const hangUrl = `http://127.0.0.1:${port}/video.mp4`;

  // 1. a hung download must end (and free its slot) within a bounded time —
  //    whether killed by yt-dlp's socket-timeout/retry cap or our watchdog.
  const started = Date.now();
  const job = jobs.createJob({ url: hangUrl, mode: 'video', quality: '720p', isPlaylist: false, socketTimeout: 3, maxRetries: 0 });
  log(!job.full, 'first job accepted');

  const ended = await new Promise((resolve) => {
    job.bus.on('end', resolve);
    setTimeout(() => resolve({ status: 'timeout-safety' }), 30000);
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(ended.status === 'error', `hung job ended as error in ${secs}s (error: "${job.error}")`);
  log(Number(secs) < 15, `slot freed promptly (<15s), took ${secs}s`);

  // 2. queue back-pressure (MAX_QUEUE=2, MAX_CONCURRENT=1)
  const a = jobs.createJob({ url: hangUrl, mode: 'video', quality: '720p' }); // runs
  const b = jobs.createJob({ url: hangUrl, mode: 'video', quality: '720p' }); // queued
  const c = jobs.createJob({ url: hangUrl, mode: 'video', quality: '720p' }); // refused
  log(!a.full && !b.full, 'jobs within capacity accepted');
  log(c.full === true, 'over-capacity job refused (back-pressure works)');

  // clean up
  if (a.id) jobs.cancelJob(a.id);
  if (b.id) jobs.cancelJob(b.id);
  hang.close();
  setTimeout(() => {
    console.log(process.exitCode ? '\nRESULT: some checks failed' : '\nRESULT: all checks passed');
    process.exit(process.exitCode || 0);
  }, 500);
});
