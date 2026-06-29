// License-gated extraction routes — the crack-resistant gateway.
//
// Mounted on the existing license server so it shares the JWT secret + key DB.
// A request only reaches yt-dlp if it carries a valid, active license token
// bound to the right device. A cracked client has no extractor and no token,
// so it gets nothing here.
//
// Exposed as a factory so server.js can inject what it already has.

const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { probe, resolveStreams, search, listExtractors } = require('../core/extractor');
const jobs = require('../web/jobs');
const usage = require('./usage');

module.exports = function createExtractRouter(deps) {
  const { jwt, JWT_SECRET, stmts, licenseState, logEvent, getIp } = deps;
  const router = express.Router();

  // Dev/testing only: skip the license check. NEVER set this in production.
  const DEV_BYPASS = process.env.LICENSE_DEV_BYPASS === '1';

  // yt-dlp network guards + per-request ceiling (mirrors the web watchdog).
  const EXTRACT_OPTS = {
    socketTimeout: parseInt(process.env.VELOX_SOCKET_TIMEOUT_SEC || '20', 10),
    maxRetries: parseInt(process.env.VELOX_DL_RETRIES || '1', 10),
    timeoutMs: parseInt(process.env.VELOX_EXTRACT_TIMEOUT_SEC || '45', 10) * 1000,
  };

  // Per-IP burst guard. Per-license daily caps belong here too (Phase 3).
  const limit = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

  function requireLicense(req, res, next) {
    if (DEV_BYPASS) { req.license = { dev: true }; return next(); }

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.body?.token || '').trim();
    if (!token) return res.status(401).json({ ok: false, error: 'license required' });

    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).json({ ok: false, error: 'invalid or expired token' }); }

    const row = stmts.findKey.get(payload.key);
    if (!row) return res.status(404).json({ ok: false, error: 'unknown key' });

    const state = licenseState(row);
    if (state !== 'active') {
      return res.status(403).json({ ok: false, error: `license ${state}`, [state]: true });
    }
    if (row.device_id && payload.deviceId !== row.device_id) {
      return res.status(409).json({ ok: false, error: 'device mismatch' });
    }
    req.license = { key: payload.key, deviceId: payload.deviceId };
    next();
  }

  // Per-license daily cap + IP-spread anomaly check. Runs after requireLicense.
  function usageGuard(req, res, next) {
    if (DEV_BYPASS || !req.license?.key) return next();
    const verdict = usage.check(req.license.key, getIp(req));
    if (!verdict.ok) {
      logEvent(verdict.block ? 'usage-block' : 'usage-cap', req.license.key, getIp(req), verdict.reason);
      if (verdict.block) { try { stmts.block.run(req.license.key, 'auto: too many devices', Date.now()); } catch {} }
      return res.status(verdict.status).json({ ok: false, error: verdict.reason });
    }
    if (verdict.alert) {
      logEvent('usage-anomaly', req.license.key, getIp(req), `${verdict.distinct} IPs within 1h`);
    }
    next();
  }

  // Step 1: probe a link -> metadata + the full menu of options for the client.
  router.post('/extract', limit, requireLicense, usageGuard, async (req, res) => {
    const info = await probe(req.body?.url, EXTRACT_OPTS);
    if (!info.ok) return res.status(422).json(info);
    if (req.license?.key) logEvent('extract', req.license.key, getIp(req), info.meta.extractor);
    res.json(info);
  });

  // Step 2: resolve a chosen option -> direct CDN stream URL(s) the client fetches.
  router.post('/resolve', limit, requireLicense, usageGuard, async (req, res) => {
    const out = await resolveStreams(req.body?.url, {
      mode: req.body?.mode,
      quality: req.body?.quality,
      aFormat: req.body?.aFormat,
      vCodec: req.body?.vCodec,
    }, EXTRACT_OPTS);
    if (!out.ok) return res.status(422).json(out);
    if (req.license?.key) logEvent('resolve', req.license.key, getIp(req), `${out.mode}/${req.body?.quality || ''}`);
    res.json(out);
  });

  // --- Full server-side download (the reliable engine: yt-dlp does everything,
  //     then the finished file is streamed to the client). Works for YouTube
  //     high-quality, HLS sites (pornhub etc.), merging — exactly like the
  //     proven desktop buildArgs. ---

  const VALID_Q = ['best', '4k', '1440p', '1080p', '720p', '480p', '360p'];

  router.post('/download/create', limit, requireLicense, usageGuard, (req, res) => {
    const b = req.body || {};
    const url = String(b.url || '');
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'invalid url' });
    const job = jobs.createJob({
      url,
      mode: b.mode === 'audio' ? 'audio' : 'video',
      quality: VALID_Q.includes(b.quality) ? b.quality : '1080p',
      audioBitrate: /^\d+$/.test(String(b.audioBitrate)) ? String(b.audioBitrate) : '192',
      aFormat: ['mp3', 'm4a', 'opus', 'flac'].includes(b.aFormat) ? b.aFormat : 'mp3',
      vContainer: ['mp4', 'mkv', 'webm'].includes(b.vContainer) ? b.vContainer : 'mp4',
      vCodec: ['auto', 'h264', 'av1', 'vp9'].includes(b.vCodec) ? b.vCodec : 'auto',
      vBitrate: Number(b.vBitrate) > 0 ? Number(b.vBitrate) : 0,
      isPlaylist: false,
      referer: typeof b.referer === 'string' ? b.referer : '',
    });
    if (job.full) return res.status(503).json({ ok: false, error: 'server is busy, please try again' });
    if (req.license?.key) logEvent('download', req.license.key, getIp(req), `${job.id} ${b.mode || 'video'}/${b.quality || ''}`);
    res.json({ ok: true, id: job.id });
  });

  router.get('/download/:id/events', requireLicense, (req, res) => {
    const job = jobs.getJob(req.params.id);
    if (!job) return res.status(404).end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const send = (ev, data) => { res.write(`event: ${ev}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); };
    const onU = (s) => send('update', s);
    const onL = (d) => send('log', d);
    const onE = (s) => send('end', s);
    job.bus.on('update', onU); job.bus.on('log', onL); job.bus.on('end', onE);
    send('update', jobs.snapshot(job));
    if (job.status === 'done' || job.status === 'error') send('end', jobs.snapshot(job));
    const ping = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); job.bus.off('update', onU); job.bus.off('log', onL); job.bus.off('end', onE); });
  });

  router.get('/download/:id/file', requireLicense, (req, res) => {
    const job = jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });
    if (job.status !== 'done' || !job.file || !fs.existsSync(job.file)) return res.status(409).json({ ok: false, error: 'file not ready' });
    res.download(job.file, path.basename(job.file));
  });

  router.post('/download/:id/cancel', requireLicense, (req, res) => {
    res.json({ ok: jobs.cancelJob(req.params.id) });
  });

  // Search + supported-sites list — also server-side so the client ships no yt-dlp.
  router.post('/search', limit, requireLicense, async (req, res) => {
    const out = await search(req.body?.query, req.body?.limit, EXTRACT_OPTS);
    if (!out.ok) return res.status(422).json(out);
    res.json(out);
  });

  router.post('/extractors', limit, requireLicense, async (_req, res) => {
    const out = await listExtractors(EXTRACT_OPTS);
    if (!out.ok) return res.status(422).json(out);
    res.json(out);
  });

  return router;
};
