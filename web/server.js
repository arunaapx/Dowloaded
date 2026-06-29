// Velox Downloader — web API (Phase 2).
//
// Public HTTP API the PWA talks to. Runs on the VPS alongside yt-dlp/ffmpeg.
//   POST /api/jobs              -> start a download, returns { id }
//   GET  /api/jobs/:id          -> one-shot status snapshot
//   GET  /api/jobs/:id/events   -> SSE stream of progress/log/end
//   GET  /api/jobs/:id/file     -> download the finished file
//   POST /api/jobs/:id/cancel   -> cancel a running/queued job
//
// License integration (reuse of the existing JWT license server) lands in
// Phase 4 — for now the API is open so the flow can be tested end to end.

try { require('dotenv').config(); } catch {}
const express = require('express');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { normalizeHttpUrl } = require('../core/downloader');
const jobs = require('./jobs');

const PORT = parseInt(process.env.WEB_PORT || '8080', 10);

const VALID_QUALITY = ['best', '4k', '1440p', '1080p', '720p', '480p', '360p'];
const VALID_ACONTAINER = ['mp3', 'm4a', 'opus', 'flac'];
const VALID_VCONTAINER = ['mp4', 'mkv', 'webm'];
const VALID_VCODEC = ['auto', 'h264', 'av1', 'vp9'];

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

const createLimit = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

function buildPayload(body) {
  const url = normalizeHttpUrl(body?.url);
  if (!url) return null;
  const mode = body?.mode === 'audio' ? 'audio' : 'video';
  return {
    url,
    mode,
    quality: VALID_QUALITY.includes(body?.quality) ? body.quality : '1080p',
    audioBitrate: /^\d+$/.test(String(body?.audioBitrate)) ? String(body.audioBitrate) : '192',
    aFormat: VALID_ACONTAINER.includes(body?.aFormat) ? body.aFormat : 'mp3',
    vContainer: VALID_VCONTAINER.includes(body?.vContainer) ? body.vContainer : 'mp4',
    vCodec: VALID_VCODEC.includes(body?.vCodec) ? body.vCodec : 'auto',
    vBitrate: Number(body?.vBitrate) > 0 ? Number(body.vBitrate) : 0,
    isPlaylist: false,
  };
}

app.post('/api/jobs', createLimit, (req, res) => {
  const payload = buildPayload(req.body);
  if (!payload) return res.status(400).json({ ok: false, error: 'invalid or missing url' });
  const job = jobs.createJob(payload);
  if (job.full) {
    return res.status(503).json({ ok: false, error: 'server is busy, please try again in a moment' });
  }
  res.json({ ok: true, id: job.id, status: job.status });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, ...jobs.snapshot(job) });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
  });
  res.write('retry: 3000\n\n');

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const onUpdate = (s) => send('update', s);
  const onLog = (d) => send('log', d);
  const onEnd = (s) => { send('end', s); };
  job.bus.on('update', onUpdate);
  job.bus.on('log', onLog);
  job.bus.on('end', onEnd);

  // Prime the client with current state, and close immediately if already finished.
  send('update', jobs.snapshot(job));
  if (job.status === 'done' || job.status === 'error') send('end', jobs.snapshot(job));

  const ping = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  const cleanup = () => {
    clearInterval(ping);
    job.bus.off('update', onUpdate);
    job.bus.off('log', onLog);
    job.bus.off('end', onEnd);
  };
  req.on('close', cleanup);
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'not found' });
  if (job.status !== 'done' || !job.file || !fs.existsSync(job.file)) {
    return res.status(409).json({ ok: false, error: 'file not ready' });
  }
  res.download(job.file, path.basename(job.file));
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  res.json({ ok: jobs.cancelJob(req.params.id) });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, concurrency: jobs.MAX_CONCURRENT, uptime: process.uptime() }));

// PWA frontend (Phase 3) is served from here.
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  const os = require('os');
  const lan = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) lan.push(i.address);
    }
  }
  console.log('\n  Velox Downloader — web app is running\n');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  On your phone/LAN:  http://${ip}:${PORT}`);
  console.log('\n  (Phone: same Wi-Fi needed. Install/offline needs HTTPS — that comes with VPS deploy.)\n');
});
