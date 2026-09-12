// License-gated extraction routes — the crack-resistant gateway.
//
// Mounted on the existing license server so it shares the JWT secret + key DB.
// A request only reaches yt-dlp if it carries a valid, active license token
// bound to the right device. A cracked client has no extractor and no token,
// so it gets nothing here.
//
// Exposed as a factory so server.js can inject what it already has.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { probe, resolveStreams, search, listExtractors } = require('../core/extractor');
const usage = require('./usage');

module.exports = function createExtractRouter(deps) {
  const { jwt, JWT_SECRET, stmts, licenseState, logEvent, getIp, boundDeviceIds } = deps;
  // Read the cap through the shared settings getter so changing it in the admin
  // panel takes effect immediately, without restarting the server.
  const trialCap = () => (deps.settings ? deps.settings().trialDownloads : TRIAL_DOWNLOADS);
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

  // Free self-signup trial cap: downloads per DEVICE (matches server.js signup).
  const TRIAL_DOWNLOADS = Math.max(1, parseInt(process.env.VELOX_TRIAL_DOWNLOADS || '5', 10));

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
    // Membership, not identity — the same test the heartbeat applies.
    //
    // This used to compare the token against the key's *primary* machine, which
    // meant a customer on a two- or three-device plan could activate their second
    // PC, pass the heartbeat on it, and then have every download refused with
    // "device mismatch". The device allowance is the thing the plans are sold on,
    // so the gate has to honour it.
    const bound = boundDeviceIds ? boundDeviceIds(row) : [row.device_id].filter(Boolean);
    if (payload.deviceId && bound.length && !bound.includes(payload.deviceId)) {
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
      // Only the daily cap can refuse now, and it clears itself at midnight.
      // Nothing here ever writes blocked=1 to a licence.
      logEvent('usage-cap', req.license.key, getIp(req), verdict.reason);
      return res.status(verdict.status).json({ ok: false, error: verdict.reason });
    }
    if (verdict.alert) {
      logEvent(verdict.severe ? 'usage-anomaly-high' : 'usage-anomaly', req.license.key, getIp(req),
        `${verdict.distinct} IPs within 1h — review by hand, not auto-blocked`);
    }
    next();
  }

  // Trial gate: for trial (self-signup) keys, cap free downloads per DEVICE.
  // The count is keyed on the device id (permanent), so swapping the email can't
  // reset it. Paid (admin) keys skip this entirely.
  function trialStatus(req) {
    const row = req.license?.key ? stmts.findKey.get(req.license.key) : null;
    const isTrial = !!(row && row.trial);
    const deviceId = req.license?.deviceId || row?.device_id || '';
    const used = isTrial && deviceId ? (stmts.getDevice.get(deviceId)?.trialDownloads || 0) : 0;
    return { isTrial, deviceId, used, exhausted: isTrial && used >= trialCap() };
  }

  function trialGuard(req, res, next) {
    if (DEV_BYPASS) return next();
    req.trial = trialStatus(req);
    if (req.trial.exhausted) {
      logEvent('trial-exhausted', req.license?.key, getIp(req), `device ${String(req.trial.deviceId).slice(0, 12)}`);
      return res.status(403).json({
        ok: false,
        error: `Free trial finished (${trialCap()} downloads). Please purchase a key.`,
        trialExpired: true,
      });
    }
    next();
  }

  // Device-side model: the client extracts + downloads with its own yt-dlp, and
  // calls this ONCE before each download. It validates the license (blocked/
  // revoked/expired via requireLicense) and spends one device-locked trial credit.
  router.post('/authorize', limit, requireLicense, usageGuard, trialGuard, (req, res) => {
    if (req.trial?.isTrial && req.trial.deviceId) stmts.bumpDeviceTrial.run(req.trial.deviceId);
    if (req.license?.key) stmts.bumpUsage.run(req.license.key);
    if (req.license?.key) logEvent('authorize', req.license.key, getIp(req), req.trial?.isTrial ? 'trial' : 'paid');
    const remaining = req.trial?.isTrial ? Math.max(0, trialCap() - (req.trial.used + 1)) : null;
    res.json({ ok: true, trial: !!req.trial?.isTrial, trialRemaining: remaining });
  });

  // Step 1: probe a link -> metadata + the full menu of options for the client.
  // Blocked early for exhausted trials so the user sees the message on paste.
  router.post('/extract', limit, requireLicense, usageGuard, trialGuard, async (req, res) => {
    const info = await probe(req.body?.url, EXTRACT_OPTS);
    if (!info.ok) return res.status(422).json(info);
    if (req.license?.key) logEvent('extract', req.license.key, getIp(req), info.meta.extractor);
    res.json(info);
  });

  // Step 2: resolve a chosen option -> direct CDN stream URL(s) the client fetches.
  // Each successful resolve = one download; it spends one trial credit on the device.
  router.post('/resolve', limit, requireLicense, usageGuard, trialGuard, async (req, res) => {
    const out = await resolveStreams(req.body?.url, {
      mode: req.body?.mode,
      quality: req.body?.quality,
      aFormat: req.body?.aFormat,
      vCodec: req.body?.vCodec,
    }, EXTRACT_OPTS);
    if (!out.ok) return res.status(422).json(out);
    if (req.trial?.isTrial && req.trial.deviceId) stmts.bumpDeviceTrial.run(req.trial.deviceId);
    if (req.license?.key) stmts.bumpUsage.run(req.license.key);
    if (req.license?.key) logEvent('resolve', req.license.key, getIp(req), `${out.mode}/${req.body?.quality || ''}`);
    res.json(out);
  });

  // Downloads run on the DEVICE (via /resolve + the bundled clientDownloader),
  // never on the server — so there are no server-side download routes here. The
  // server only probes and resolves; no media file ever touches it.

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
