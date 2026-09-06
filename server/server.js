require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { customAlphabet } = require('nanoid');
const { db, stmts, logEvent } = require('./db');
const createExtractRouter = require('./extract');

const PORT = parseInt(process.env.PORT || '4000', 10);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const TOKEN_TTL_HOURS = parseInt(process.env.TOKEN_TTL_HOURS || '24', 10);
const DEFAULT_LICENSE_DAYS = parseInt(process.env.DEFAULT_LICENSE_DAYS || '30', 10);
const DAY_MS = 24 * 60 * 60 * 1000;
// Free self-signup trial: N downloads per DEVICE (not per email), tracked
// permanently so swapping the email can't reset the quota.
const TRIAL_DOWNLOADS = Math.max(1, parseInt(process.env.VELOX_TRIAL_DOWNLOADS || '5', 10));

// Persist JWT secret in data/ so tokens survive restart
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');
let JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  if (fs.existsSync(SECRET_FILE)) {
    JWT_SECRET = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
  } else {
    JWT_SECRET = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(SECRET_FILE, JWT_SECRET, { mode: 0o600 });
  }
}

if (!ADMIN_PASS) {
  console.warn('[velox-license] WARNING: ADMIN_PASS is empty. Set it in .env before exposing the server.');
}

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newKeyId = customAlphabet(KEY_ALPHABET, 5);
function makeKey() {
  // VLX-XXXXX-XXXXX-XXXXX
  return `VLX-${newKeyId()}-${newKeyId()}-${newKeyId()}`;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

// --- helpers ---
const getIp = (req) => (req.ip || req.headers['x-forwarded-for'] || '').toString();
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (msg, code = 400) => ({ status: code, body: { ok: false, error: msg } });

function emailOk(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200;
}

function normalizeKey(v) {
  return String(v || '').trim().toUpperCase().replace(/\s+/g, '');
}

// Shown when someone hits a device that already belongs to another account.
// Enough for the real owner to recognise their own address, not enough to leak
// a stranger's to whoever is sitting at the machine.
function maskEmail(v) {
  const s = String(v || '');
  const at = s.indexOf('@');
  if (at < 1) return 'another account';
  const name = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${'*'.repeat(Math.max(1, name.length - head.length))}@${domain}`;
}

function parseLicenseDays(v, fallback = DEFAULT_LICENSE_DAYS) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 36500) return null;
  return Math.floor(n);
}

function expiresAtFromDays(days) {
  if (!days) return null;
  return Date.now() + days * DAY_MS;
}

function parseExpiresAt(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 0 ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const numeric = Number(s);
  if (Number.isFinite(numeric)) return numeric > 0 ? numeric : null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function daysRemaining(expiresAt) {
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / DAY_MS));
}

function licenseState(row) {
  if (!row) return 'missing';
  if (row.revoked) return 'revoked';
  if (row.blocked) return 'blocked';
  if (row.expires_at && row.expires_at <= Date.now()) return 'expired';
  return row.device_id ? 'active' : 'pending';
}

// Runtime settings, editable in the admin panel. Anything the admin has not
// touched falls through to the env var, so behaviour is unchanged until someone
// actually changes something in the UI.
function settings() {
  const s = stmts.getSettings.get() || {};
  const trial = Number(s.trialDownloads);
  const days = Number(s.defaultLicenseDays);
  return {
    signupEnabled: s.signupEnabled === undefined ? true : !!s.signupEnabled,
    trialDownloads: Number.isFinite(trial) && trial >= 1 ? Math.floor(trial) : TRIAL_DOWNLOADS,
    defaultLicenseDays: Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_LICENSE_DAYS,
  };
}

// Free downloads left on a trial key's bound device (null for paid keys).
function trialRemaining(row) {
  if (!row || !row.trial) return null;
  const dev = row.device_id ? stmts.getDevice.get(row.device_id) : null;
  const used = dev ? (dev.trialDownloads || 0) : 0;
  return Math.max(0, settings().trialDownloads - used);
}

function publicProfile(row) {
  return {
    key: row.key,
    email: row.email || '',
    note: row.note || '',
    deviceName: row.device_name || '',
    expiresAt: row.expires_at || null,
    daysRemaining: daysRemaining(row.expires_at),
    status: licenseState(row),
    trial: !!row.trial,
    trialTotal: row.trial ? settings().trialDownloads : null,
    trialRemaining: trialRemaining(row),
  };
}

function publicAdminKey(row) {
  const dev = row.trial && row.device_id ? stmts.getDevice.get(row.device_id) : null;
  return {
    ...row,
    status: licenseState(row),
    days_remaining: daysRemaining(row.expires_at),
    trial: !!row.trial,
    trial_used: dev ? (dev.trialDownloads || 0) : 0,
    trial_total: row.trial ? settings().trialDownloads : null,
  };
}

// --- session cookie auth ---
const ADMIN_COOKIE = 'velox_admin';
const ADMIN_TTL = 12 * 3600;  // 12 hours

function parseCookies(req) {
  const out = {};
  const hdr = req.headers.cookie || '';
  hdr.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    if (k) out[k] = v;
  });
  return out;
}

function setAdminCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  const flags = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${ADMIN_TTL}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (isProd) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}
function clearAdminCookie(res) {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
}

function requireAdmin(req, res, next) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!token) {
    if (req.path.startsWith('/admin/api/')) return res.status(401).json({ ok: false, error: 'unauthorized' });
    return res.redirect('/login');
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('bad role');
    req.admin = payload;
    next();
  } catch {
    clearAdminCookie(res);
    if (req.path.startsWith('/admin/api/')) return res.status(401).json({ ok: false, error: 'session expired' });
    return res.redirect('/login');
  }
}

const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/admin-login', loginLimit, (req, res) => {
  const u = String(req.body?.username || '').trim();
  const p = String(req.body?.password || '');
  if (!ADMIN_PASS) return res.status(500).json({ ok: false, error: 'ADMIN_PASS not set on server' });
  if (u !== ADMIN_USER || p !== ADMIN_PASS) {
    logEvent('admin-login-fail', null, getIp(req), u);
    return res.status(401).json({ ok: false, error: 'invalid credentials' });
  }
  const token = jwt.sign({ role: 'admin', u }, JWT_SECRET, { expiresIn: ADMIN_TTL });
  setAdminCookie(res, token);
  logEvent('admin-login', null, getIp(req), u);
  res.json({ ok: true });
});
app.post('/api/admin-logout', (_req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

// --- public API ---

const signupLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });
const activateLimit = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const heartbeatLimit = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

app.post('/api/signup', signupLimit, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const deviceId = String(req.body?.deviceId || '').trim();
  const deviceName = String(req.body?.deviceName || '').trim().slice(0, 100);
  // Master switch for the free trial, toggled in the admin panel. Existing trial
  // keys keep working; this only stops NEW ones being handed out.
  if (!settings().signupEnabled) {
    logEvent('signup-disabled', null, getIp(req), email);
    return res.status(403).json({
      ok: false,
      error: 'Free trial sign-up is closed. Please purchase a key.',
      signupDisabled: true,
    });
  }
  if (!emailOk(email)) return res.status(400).json({ ok: false, error: 'invalid email' });
  // Hardware binding happens at registration, so a device id is mandatory now.
  if (!deviceId) return res.status(400).json({ ok: false, error: 'missing device id' });

  const existing = stmts.findEmail.get(email);
  if (existing) {
    const state = licenseState(existing);
    if (state === 'revoked') {
      logEvent('signup-revoked-attempt', existing.key, getIp(req), email);
      return res.status(403).json({ ok: false, error: 'key revoked' });
    }
    if (state === 'blocked') {
      logEvent('signup-blocked-attempt', existing.key, getIp(req), email);
      return res.status(403).json({ ok: false, error: 'user blocked', blocked: true });
    }
    if (state === 'expired') {
      logEvent('signup-expired-attempt', existing.key, getIp(req), email);
      return res.status(403).json({ ok: false, error: 'license expired', expired: true });
    }
    // Hardware lock. The email belongs to the machine it was registered on, and
    // only an admin reset-device can move it. A second machine is refused, not
    // blocked: the account stays perfectly healthy on its own device.
    const boundDevice = existing.device_id || (stmts.findDeviceByEmail.get(email) || {}).deviceId || null;
    if (boundDevice && boundDevice !== deviceId) {
      logEvent('signup-device-mismatch', existing.key, getIp(req),
        `${email} bound:${boundDevice.slice(0, 12)} tried:${deviceId.slice(0, 12)}`);
      return res.status(409).json({
        ok: false,
        error: 'This email is already connected with another device. Contact support to move it.',
        deviceMismatch: true,
      });
    }

    // Same machine (or a key that had never been bound): (re)assert the binding
    // so an older key created before hardware binding existed gets locked now.
    if (!existing.device_id) stmts.bindDevice.run(deviceId, deviceName, Date.now(), existing.key);
    stmts.bindDeviceEmail.run(deviceId, email, existing.key);
    logEvent('signup-existing', existing.key, getIp(req), email);
    return res.json(ok({ key: existing.key, expiresAt: existing.expires_at || null, profile: publicProfile(stmts.findKey.get(existing.key)), message: 'existing key returned' }));
  }

  // A new email on a machine that already belongs to someone else. Refused so
  // one device cannot farm an unlimited supply of trial accounts.
  const dev = stmts.getDevice.get(deviceId);
  if (dev && dev.email && dev.email !== email) {
    logEvent('signup-device-taken', dev.key || null, getIp(req),
      `device ${deviceId.slice(0, 12)} holds ${dev.email}, tried ${email}`);
    return res.status(409).json({
      ok: false,
      error: `This device is already registered to ${maskEmail(dev.email)}. One device, one account.`,
      deviceTaken: true,
    });
  }

  // Device-locked trial: once this device has spent its free downloads, no new
  // trial key — swapping the email can't reset the quota.
  if (dev && (dev.trialDownloads || 0) >= settings().trialDownloads) {
    logEvent('signup-trial-exhausted', null, getIp(req), `${email} / device ${deviceId.slice(0, 12)}`);
    return res.status(403).json({
      ok: false,
      error: `Free trial finished (${settings().trialDownloads} downloads) on this device. Please purchase a key.`,
      trialExpired: true,
    });
  }

  const key = makeKey();
  const expiresAt = expiresAtFromDays(settings().defaultLicenseDays);
  stmts.insertKey.run(key, email, Date.now(), 'self-signup-trial', expiresAt, 1); // trial=1
  // Bind the hardware at registration, not at activation. Until this existed a
  // key sat unbound between the two calls and anyone who knew the email could
  // claim it from any machine.
  stmts.bindDevice.run(deviceId, deviceName, Date.now(), key);
  stmts.bindDeviceEmail.run(deviceId, email, key);
  const row = stmts.findKey.get(key);
  logEvent('signup-trial', key, getIp(req), `${email} / device ${deviceId.slice(0, 12)}`);
  res.json(ok({ key, expiresAt, profile: publicProfile(row) }));
});

app.post('/api/activate', activateLimit, (req, res) => {
  const key = normalizeKey(req.body?.key);
  const deviceId = String(req.body?.deviceId || '').trim();
  const deviceName = String(req.body?.deviceName || '').trim().slice(0, 100);

  if (!key || !deviceId) return res.status(400).json({ ok: false, error: 'missing fields' });

  const row = stmts.findKey.get(key);
  if (!row) {
    logEvent('activate-unknown-key', key, getIp(req), deviceId);
    return res.status(404).json({ ok: false, error: 'unknown key' });
  }
  const state = licenseState(row);
  if (state === 'revoked') {
    logEvent('activate-revoked', key, getIp(req), deviceId);
    return res.status(403).json({ ok: false, error: 'key revoked' });
  }
  if (state === 'blocked') {
    logEvent('activate-blocked', key, getIp(req), deviceId);
    return res.status(403).json({ ok: false, error: 'user blocked', blocked: true });
  }
  if (state === 'expired') {
    logEvent('activate-expired', key, getIp(req), deviceId);
    return res.status(403).json({ ok: false, error: 'license expired', expired: true });
  }
  if (row.device_id && row.device_id !== deviceId) {
    logEvent('activate-conflict', key, getIp(req), `bound:${row.device_id} vs ${deviceId}`);
    return res.status(409).json({
      ok: false,
      error: 'This key is already connected with another device. Contact support to move it.',
      deviceMismatch: true,
    });
  }

  // The other direction: this machine already belongs to a different account.
  // Refused, never blocked - both accounts stay healthy on their own hardware.
  const dev = stmts.getDevice.get(deviceId);
  if (dev && dev.email && row.email && dev.email !== String(row.email).toLowerCase()) {
    logEvent('activate-device-taken', key, getIp(req),
      `device ${deviceId.slice(0, 12)} holds ${dev.email}`);
    return res.status(409).json({
      ok: false,
      error: `This device is already registered to ${maskEmail(dev.email)}. One device, one account.`,
      deviceTaken: true,
    });
  }

  if (!row.device_id) {
    stmts.bindDevice.run(deviceId, deviceName, Date.now(), key);
    logEvent('activate', key, getIp(req), `${deviceName} / ${deviceId}`);
  } else {
    logEvent('reactivate', key, getIp(req), deviceId);
  }
  // Keep the hardware ledger in step with the key, so the email<->device lock
  // holds for admin-issued and purchased keys too, not just self-signups.
  if (row.email) stmts.bindDeviceEmail.run(deviceId, row.email, key);

  const token = jwt.sign(
    { key, deviceId, email: row.email },
    JWT_SECRET,
    { expiresIn: `${TOKEN_TTL_HOURS}h` }
  );
  res.json(ok({
    token,
    email: row.email,
    expiresAt: row.expires_at || null,
    daysRemaining: daysRemaining(row.expires_at),
    profile: publicProfile(row),
    expiresIn: TOKEN_TTL_HOURS * 3600,
  }));
});

app.post('/api/heartbeat', heartbeatLimit, (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ ok: false, error: 'missing token' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }
  const row = stmts.findKey.get(payload.key);
  if (!row) return res.status(404).json({ ok: false, error: 'unknown key' });
  const state = licenseState(row);
  if (state === 'revoked') {
    logEvent('heartbeat-revoked', payload.key, getIp(req), payload.deviceId);
    return res.status(403).json({ ok: false, error: 'key revoked', revoked: true });
  }
  if (state === 'blocked') {
    logEvent('heartbeat-blocked', payload.key, getIp(req), payload.deviceId);
    return res.status(403).json({ ok: false, error: 'user blocked', blocked: true });
  }
  if (state === 'expired') {
    logEvent('heartbeat-expired', payload.key, getIp(req), payload.deviceId);
    return res.status(403).json({ ok: false, error: 'license expired', expired: true });
  }
  if (row.device_id && payload.deviceId !== row.device_id) {
    return res.status(409).json({ ok: false, error: 'device mismatch' });
  }
  stmts.bumpHeartbeat.run(Date.now(), payload.key);
  // Rotate the access token on every heartbeat so a leaked token is quickly
  // superseded and never lives much longer than one heartbeat interval.
  const freshToken = jwt.sign(
    { key: payload.key, deviceId: payload.deviceId, email: row.email },
    JWT_SECRET,
    { expiresIn: `${TOKEN_TTL_HOURS}h` }
  );
  res.json(ok({
    token: freshToken,
    revoked: false,
    blocked: false,
    expired: false,
    expiresAt: row.expires_at || null,
    daysRemaining: daysRemaining(row.expires_at),
    profile: publicProfile(row),
  }));
});

// --- license-gated extraction API (thin-client model) ---
app.use('/api', createExtractRouter({ jwt, JWT_SECRET, stmts, licenseState, logEvent, getIp, settings }));

// --- internal API (loopback only) ---
//
// The Rust store service (store/) calls this the moment a PayPal payment is
// captured, so a buyer gets their key on the thank-you screen instead of waiting
// for someone to make one by hand. Two independent guards: a shared token, and a
// hard loopback check so it stays unreachable from the internet even if nginx is
// ever misconfigured to forward /internal.
const INTERNAL_TOKEN = process.env.VELOX_INTERNAL_TOKEN || '';

function isLoopback(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function internalTokenOk(supplied) {
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(INTERNAL_TOKEN);
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/internal/issue-key', (req, res) => {
  if (!INTERNAL_TOKEN) {
    return res.status(503).json({ ok: false, error: 'internal API disabled (VELOX_INTERNAL_TOKEN unset)' });
  }
  if (!isLoopback(req)) {
    logEvent('internal-remote-attempt', null, getIp(req), 'issue-key');
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  if (!internalTokenOk(req.headers['x-internal-token'])) {
    logEvent('internal-auth-fail', null, getIp(req), 'issue-key');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!emailOk(email)) return res.status(400).json({ ok: false, error: 'invalid email' });
  const days = parseLicenseDays(req.body?.days, 0);
  if (days === null) return res.status(400).json({ ok: false, error: 'invalid license days' });
  const note = String(req.body?.note || 'purchase').trim().slice(0, 200);

  const key = makeKey();
  const expiresAt = expiresAtFromDays(days);
  stmts.insertKey.run(key, email, Date.now(), note, expiresAt, 0); // paid: trial=0, no download cap
  logEvent('purchase-issue', key, getIp(req), `${email} / ${days || 'lifetime'}`);
  res.json({ ok: true, key, expiresAt });
});

// --- admin API ---

app.get('/admin/api/keys', requireAdmin, (_req, res) => {
  res.json({ ok: true, keys: stmts.allKeys.all().map(publicAdminKey) });
});

app.get('/admin/api/events', requireAdmin, (_req, res) => {
  res.json({ ok: true, events: stmts.recentEvents.all() });
});

// --- settings: the free-trial switch and its size ---
app.get('/admin/api/settings', requireAdmin, (_req, res) => {
  res.json(ok({ settings: settings() }));
});

app.post('/admin/api/settings', requireAdmin, (req, res) => {
  const patch = {};

  if (req.body?.signupEnabled !== undefined) {
    patch.signupEnabled = !!req.body.signupEnabled;
  }
  if (req.body?.trialDownloads !== undefined) {
    const n = Number(req.body.trialDownloads);
    if (!Number.isFinite(n) || n < 1 || n > 10000) {
      return res.status(400).json({ ok: false, error: 'trial downloads must be between 1 and 10000' });
    }
    patch.trialDownloads = Math.floor(n);
  }
  if (req.body?.defaultLicenseDays !== undefined) {
    const n = Number(req.body.defaultLicenseDays);
    if (!Number.isFinite(n) || n < 0 || n > 36500) {
      return res.status(400).json({ ok: false, error: 'default days must be between 0 and 36500' });
    }
    patch.defaultLicenseDays = Math.floor(n);
  }

  stmts.saveSettings.run(patch);
  logEvent('admin-settings', null, getIp(req), JSON.stringify(patch));
  res.json(ok({ settings: settings() }));
});

// --- the device ledger: what the hardware lock actually holds ---
app.get('/admin/api/devices', requireAdmin, (_req, res) => {
  const cap = settings().trialDownloads;
  const devices = stmts.allDevices.all().map((d) => ({
    ...d,
    trialDownloads: d.trialDownloads || 0,
    trialRemaining: Math.max(0, cap - (d.trialDownloads || 0)),
    keyStatus: d.key ? licenseState(stmts.findKey.get(d.key)) : null,
  }));
  res.json(ok({ devices, trialCap: cap }));
});

// Give one machine its free trial back.
app.post('/admin/api/devices/:id/reset-trial', requireAdmin, (req, res) => {
  const id = String(req.params.id || '').trim();
  const r = stmts.resetDeviceTrial.run(id);
  logEvent('admin-device-reset-trial', null, getIp(req), id.slice(0, 16));
  res.json(ok({ changed: r.changes }));
});

// Free a machine so a different account can register on it. Keeps the trial
// count, so unbinding is not a way to farm new trials.
app.post('/admin/api/devices/:id/unbind', requireAdmin, (req, res) => {
  const id = String(req.params.id || '').trim();
  const dev = stmts.getDevice.get(id);
  if (dev && dev.key) stmts.resetDevice.run(dev.key);
  const r = stmts.clearDeviceBinding.run(id);
  logEvent('admin-device-unbind', dev?.key || null, getIp(req), id.slice(0, 16));
  res.json(ok({ changed: r.changes }));
});

app.delete('/admin/api/devices/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '').trim();
  const dev = stmts.getDevice.get(id);
  if (dev && dev.key) stmts.resetDevice.run(dev.key);
  const r = stmts.deleteDevice.run(id);
  logEvent('admin-device-delete', dev?.key || null, getIp(req), id.slice(0, 16));
  res.json(ok({ changed: r.changes }));
});

// Turn a free-trial key into a paid one - lifts the download cap for good.
// For customers who paid you directly rather than through the site.
app.post('/admin/api/keys/:key/make-paid', requireAdmin, (req, res) => {
  const key = normalizeKey(req.params.key);
  const row = stmts.findKey.get(key);
  if (!row) return res.status(404).json({ ok: false, error: 'unknown key' });
  const r = stmts.setKeyPaid.run(key);
  logEvent('admin-make-paid', key, getIp(req), row.email || '');
  res.json(ok({ changed: r.changes, key: publicAdminKey(stmts.findKey.get(key)) }));
});

app.post('/admin/api/keys', requireAdmin, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const note  = String(req.body?.note || 'admin-created').trim().slice(0, 200);
  const days = parseLicenseDays(req.body?.days);
  if (email && !emailOk(email)) return res.status(400).json({ ok: false, error: 'invalid email' });
  if (days === null) return res.status(400).json({ ok: false, error: 'invalid license days' });
  const key = makeKey();
  const expiresAt = expiresAtFromDays(days);
  stmts.insertKey.run(key, email || null, Date.now(), note, expiresAt, 0); // admin keys are paid (no trial cap)
  const row = stmts.findKey.get(key);
  logEvent('admin-create', key, getIp(req), `${email || 'no-email'} / ${days || 'lifetime'} days`);
  res.json(ok({ key, expiresAt, profile: publicProfile(row) }));
});

app.patch('/admin/api/keys/:key', requireAdmin, (req, res) => {
  const key = normalizeKey(req.params.key);
  const row = stmts.findKey.get(key);
  if (!row) return res.status(404).json({ ok: false, error: 'unknown key' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const note = String(req.body?.note || '').trim().slice(0, 200);
  const expiresAt = parseExpiresAt(req.body?.expiresAt);
  if (email && !emailOk(email)) return res.status(400).json({ ok: false, error: 'invalid email' });
  if (expiresAt === undefined) return res.status(400).json({ ok: false, error: 'invalid expiry date' });
  const r = stmts.updateKey.run(key, email || null, note || null, expiresAt || null);
  // Keep the hardware ledger in step: changing someone's email in the panel is
  // the supported way to move an account, so the bound device must follow it or
  // the old address would keep the lock.
  if (email && email !== String(row.email || '').toLowerCase()) {
    stmts.devicesForKey.all(key).forEach((d) => stmts.bindDeviceEmail.run(d.deviceId, email, key));
  }
  logEvent('admin-update', key, getIp(req), `${email || 'no-email'} / ${expiresAt || 'lifetime'}`);
  res.json(ok({ changed: r.changes, key: publicAdminKey(stmts.findKey.get(key)) }));
});

app.post('/admin/api/keys/:key/extend', requireAdmin, (req, res) => {
  const key = normalizeKey(req.params.key);
  const row = stmts.findKey.get(key);
  if (!row) return res.status(404).json({ ok: false, error: 'unknown key' });
  const days = parseLicenseDays(req.body?.days, 30);
  if (days === null || days === 0) return res.status(400).json({ ok: false, error: 'invalid extension days' });
  const base = row.expires_at && row.expires_at > Date.now() ? row.expires_at : Date.now();
  const expiresAt = base + days * DAY_MS;
  const r = stmts.updateKey.run(key, row.email || null, row.note || null, expiresAt);
  logEvent('admin-extend', key, getIp(req), `${days} days`);
  res.json(ok({ changed: r.changes, key: publicAdminKey(stmts.findKey.get(key)) }));
});

app.post('/admin/api/keys/:key/block', requireAdmin, (req, res) => {
  const key = normalizeKey(req.params.key);
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  const r = stmts.block.run(key, reason, Date.now());
  logEvent('admin-block', key, getIp(req), reason);
  res.json(ok({ changed: r.changes }));
});

app.post('/admin/api/keys/:key/unblock', requireAdmin, (req, res) => {
  const key = normalizeKey(req.params.key);
  const r = stmts.unblock.run(key);
  logEvent('admin-unblock', key, getIp(req), '');
  res.json(ok({ changed: r.changes }));
});

app.post('/admin/api/keys/:key/revoke', requireAdmin, (req, res) => {
  const key = normalizeKey(req.params.key);
  const r = stmts.revoke.run(key);
  logEvent('admin-revoke', key, getIp(req), '');
  res.json(ok({ changed: r.changes }));
});

app.post('/admin/api/keys/:key/unrevoke', requireAdmin, (req, res) => {
  const key = normalizeKey(req.params.key);
  const r = stmts.unrevoke.run(key);
  logEvent('admin-unrevoke', key, getIp(req), '');
  res.json(ok({ changed: r.changes }));
});

// The only way a user moves to new hardware. Clears the key's device AND the
// email<->device ledger entry, otherwise the old machine would stay bound and
// the customer could never activate anywhere else.
// The device's trialDownloads count is deliberately preserved, so a reset is
// not a way to farm fresh free trials.
app.post('/admin/api/keys/:key/reset-device', requireAdmin, (req, res) => {
  const key = normalizeKey(req.params.key);
  const bound = stmts.devicesForKey.all(key);
  bound.forEach((d) => stmts.clearDeviceBinding.run(d.deviceId));
  const r = stmts.resetDevice.run(key);
  logEvent('admin-reset-device', key, getIp(req), `unbound ${bound.length} device(s)`);
  res.json(ok({ changed: r.changes, unboundDevices: bound.length }));
});

app.delete('/admin/api/keys/:key', requireAdmin, (req, res) => {
  const key = normalizeKey(req.params.key);
  const r = stmts.delKey.run(key);
  logEvent('admin-delete', key, getIp(req), '');
  res.json(ok({ changed: r.changes }));
});

// --- public login page (no auth) ---
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// --- static admin UI (protected) ---
// Note: admin.css is referenced by the public login page; serve it without auth.
app.get('/admin/admin.css', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.css'));
});
app.use('/admin', requireAdmin, express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get('/', (req, res) => {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!token) return res.redirect('/login');
  res.redirect('/admin/');
});

// --- health check ---
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'server error' });
});

app.listen(PORT, () => {
  console.log(`[velox-license] listening on http://0.0.0.0:${PORT}`);
  console.log(`[velox-license] admin user: ${ADMIN_USER}`);
});
