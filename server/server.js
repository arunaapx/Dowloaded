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
// Default sign-ups per hour per IP. Generous on purpose; see settings().
const SIGNUP_PER_HOUR = Math.max(0, parseInt(process.env.VELOX_SIGNUP_PER_HOUR || '60', 10));
// Machines per key when neither the key nor its plan says otherwise. One is the
// old behaviour, and stays the default.
const DEFAULT_DEVICE_LIMIT = Math.max(1, parseInt(process.env.VELOX_DEVICE_LIMIT || '1', 10));

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
const newNoticeId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);
function makeKey() {
  // VLX-XXXXX-XXXXX-XXXXX
  return `VLX-${newKeyId()}-${newKeyId()}-${newKeyId()}`;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

// The YouTube cookie jar, if one has been uploaded. Applied at boot so a
// restart does not quietly drop back to anonymous extraction.
const ytCookies = require('./cookies');
if (ytCookies.apply()) {
  console.log('[velox-license] YouTube cookies loaded from', ytCookies.COOKIE_FILE);
}

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
  // Sign-ups per hour from one IP. Mobile carriers put hundreds of real
  // customers behind a single address (CGNAT), so a tight cap here blocks
  // innocent people, not abusers - the one-email-per-device hardware lock is
  // what actually limits how many keys anyone can obtain. 0 turns it off.
  const perHour = Number(s.signupPerHour);
  const devices = Number(s.defaultDeviceLimit);
  return {
    defaultDeviceLimit: Number.isFinite(devices) && devices >= 1 ? Math.floor(devices) : DEFAULT_DEVICE_LIMIT,
    signupEnabled: s.signupEnabled === undefined ? true : !!s.signupEnabled,
    trialDownloads: Number.isFinite(trial) && trial >= 1 ? Math.floor(trial) : TRIAL_DOWNLOADS,
    defaultLicenseDays: Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_LICENSE_DAYS,
    signupPerHour: Number.isFinite(perHour) && perHour >= 0 ? Math.floor(perHour) : SIGNUP_PER_HOUR,
  };
}

// Every machine this key is registered on. The ledger is the record, but a key
// bound before the ledger existed only has device_id, so both are counted.
function boundDeviceIds(row) {
  if (!row) return [];
  const ids = new Set();
  if (row.device_id) ids.add(row.device_id);
  for (const d of stmts.devicesForKey.all(row.key)) if (d.deviceId) ids.add(d.deviceId);
  return [...ids];
}

// How many machines this key may run on: its own override first, then whatever
// its plan allows, then the default. Raising a plan's allowance therefore lifts
// every key sold on that plan, without touching them one by one.
function deviceLimitFor(row) {
  if (!row) return settings().defaultDeviceLimit;
  const override = Number(row.device_limit);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  const plan = row.plan ? stmts.allPlans.all().find((p) => p.id === row.plan) : null;
  const fromPlan = plan ? Number(plan.devices) : NaN;
  if (Number.isFinite(fromPlan) && fromPlan >= 1) return Math.floor(fromPlan);
  return settings().defaultDeviceLimit;
}

// May this machine join this key? Already-registered machines always may.
function deviceAllowed(row, deviceId) {
  const bound = boundDeviceIds(row);
  if (bound.includes(deviceId)) return { ok: true, bound, limit: deviceLimitFor(row), known: true };
  const limit = deviceLimitFor(row);
  return { ok: bound.length < limit, bound, limit, known: false };
}

// Registers a machine against a key, in the ledger and (for the first one) on
// the key itself, so old code that reads key.device_id still sees a device.
function bindDeviceRow(row, deviceId, deviceName) {
  if (!row.device_id) stmts.bindDevice.run(deviceId, deviceName, Date.now(), row.key);
  stmts.bindDeviceToKey.run(deviceId, row.key, row.email || '', deviceName);
}

function deviceLimitError(check) {
  return check.limit === 1
    ? 'This key is already connected with another device. Contact support to move it.'
    : `This key is already in use on ${check.bound.length} of ${check.limit} devices. Remove one, or contact support.`;
}

// Free downloads left on a trial key's bound device (null for paid keys).
function trialRemaining(row) {
  if (!row || !row.trial) return null;
  const dev = row.device_id ? stmts.getDevice.get(row.device_id) : null;
  const used = dev ? (dev.trialDownloads || 0) : 0;
  return Math.max(0, settings().trialDownloads - used);
}

// The pricing table as the app sees it: only plans someone has finished
// filling in and switched on. An unpriced or inactive plan stays in the admin
// panel and never reaches a customer, so a half-written price can't ship.
function publicPlans() {
  return stmts.allPlans.all()
    .filter((p) => p.active && String(p.price || '').trim())
    .map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      period: p.period || '',
      devices: Number(p.devices) || 1,
      features: Array.isArray(p.features) ? p.features : [],
      highlight: !!p.highlight,
      buyUrl: p.buyUrl || '',
      order: p.order || 0,
    }));
}

// Who a notice is for. `trial-exhausted` is the moment worth catching: the
// person has spent every free download and is looking at a wall, which is
// exactly when an upgrade offer is worth showing.
function noticeMatches(notice, row) {
  const audience = notice.audience || 'all';
  if (audience === 'all') return true;
  if (!row) return false;
  const expired = !!(row.expires_at && row.expires_at <= Date.now());
  if (audience === 'expired') return expired;
  if (audience === 'trial') return !!row.trial && !expired;
  if (audience === 'paid') return !row.trial && !expired;
  if (audience === 'trial-exhausted') return !!row.trial && !expired && trialRemaining(row) === 0;
  return false;
}

function noticesFor(row) {
  return stmts.allNotices.all()
    .filter((n) => n.active && noticeMatches(n, row))
    .map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      level: n.level || 'info',
      actionLabel: n.actionLabel || '',
      actionUrl: n.actionUrl || '',
      createdAt: n.created_at || 0,
    }));
}

// What the app is told about the plan a key was sold on. A trial key has no
// plan of its own, so it is named as the trial it is.
function planFor(row) {
  if (row.trial) return { id: null, name: 'Free trial', features: [] };
  const plan = stmts.allPlans.all().find((p) => p.id === row.plan);
  if (!plan) return { id: null, name: 'Licensed', features: [] };
  return {
    id: plan.id,
    name: plan.name,
    price: plan.price || '',
    period: plan.period || '',
    devices: Number(plan.devices) || 1,
    features: Array.isArray(plan.features) ? plan.features : [],
  };
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
    plan: planFor(row),
    downloadsToday: stmts.getUsage.get(row.key).count,
    devices: { used: boundDeviceIds(row).length, limit: deviceLimitFor(row) },
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
    devices_used: boundDeviceIds(row).length,
    devices_limit: deviceLimitFor(row),
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

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many sign-in attempts. Please wait 15 minutes.', rateLimited: true }),
});
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

// express-rate-limit answers with PLAIN TEXT by default. Every client here
// parses JSON, so a rate-limited reply used to blow up in JSON.parse and the
// user saw the word "parse" instead of being told to wait. Always answer JSON.
function limited(windowMs, max, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const mins = Math.max(1, Math.ceil(windowMs / 60000));
      logEvent('rate-limited', null, getIp(req), req.path);
      res.status(429).json({ ok: false, error: message, rateLimited: true, retryAfterMinutes: mins });
    },
  });
}

// Read the cap on every request so changing it in the admin panel applies at
// once, and skip the limiter entirely when it is set to 0.
const signupLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: () => settings().signupPerHour,
  skip: () => settings().signupPerHour <= 0,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logEvent('rate-limited', null, getIp(req), '/api/signup');
    res.status(429).json({
      ok: false,
      error: 'Too many sign-up attempts from this network. Please wait a while, or paste a key you already have.',
      rateLimited: true,
      retryAfterMinutes: 60,
    });
  },
});
const activateLimit = limited(60 * 1000, Math.max(1, parseInt(process.env.VELOX_ACTIVATE_PER_MIN || '10', 10)),
  'Too many activation attempts. Please wait a minute and try again.');
const heartbeatLimit = limited(60 * 1000, Math.max(1, parseInt(process.env.VELOX_HEARTBEAT_PER_MIN || '30', 10)),
  'Too many requests. Please wait a minute.');

// The published pricing table, open to anyone.
//
// The app receives this on its heartbeat, but the website needs the same three
// tiers and a visitor has no licence to authenticate with — so this one is
// public. It carries only what an admin ticked Published, which is exactly
// what the site exists to show. nginx on the store vhost proxies /api/plans
// here so the page can fetch it same-origin.
//
// Deliberately not rate-limited: behind that proxy every request arrives from
// 127.0.0.1, so a per-IP limiter would throttle every visitor at once.
app.get('/api/plans', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(ok({ plans: publicPlans() }));
});

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
    const check = deviceAllowed(existing, deviceId);
    if (!check.ok) {
      logEvent('signup-device-mismatch', existing.key, getIp(req),
        `${email} on ${check.bound.length}/${check.limit} devices, tried:${deviceId.slice(0, 12)}`);
      return res.status(409).json({
        ok: false,
        error: deviceLimitError(check),
        deviceMismatch: true,
        devices: { used: check.bound.length, limit: check.limit },
      });
    }

    // A machine that is already on the key, or one the allowance has room for.
    bindDeviceRow(existing, deviceId, deviceName);
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
  stmts.bindDeviceToKey.run(deviceId, key, email, deviceName);
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
  const check = deviceAllowed(row, deviceId);
  if (!check.ok) {
    logEvent('activate-conflict', key, getIp(req), `${check.bound.length}/${check.limit} devices, tried ${deviceId.slice(0, 12)}`);
    return res.status(409).json({
      ok: false,
      error: deviceLimitError(check),
      deviceMismatch: true,
      devices: { used: check.bound.length, limit: check.limit },
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

  if (check.known) {
    logEvent('reactivate', key, getIp(req), deviceId);
  } else {
    logEvent('activate', key, getIp(req), `${deviceName} / ${deviceId} (${check.bound.length + 1}/${check.limit})`);
  }
  bindDeviceRow(row, deviceId, deviceName);
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
    plans: publicPlans(),
    notices: noticesFor(row),
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
    return res.status(403).json({
      ok: false, error: 'license expired', expired: true,
      plans: publicPlans(), notices: noticesFor(row),
    });
  }
  // Membership, not identity: a key may legitimately run on several machines,
  // and an admin unbinding one is what takes it away again.
  if (payload.deviceId && !boundDeviceIds(row).includes(payload.deviceId)) {
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
    plans: publicPlans(),
    notices: noticesFor(row),
  }));
});

// --- license-gated extraction API (thin-client model) ---
app.use('/api', createExtractRouter({ jwt, JWT_SECRET, stmts, licenseState, logEvent, getIp, settings, boundDeviceIds }));

// --- internal API (loopback only) ---
//
// The Rust store service (store/) calls this the moment a PayPal payment is
// captured, so a buyer gets their key on the thank-you screen instead of waiting
// for someone to make one by hand. Two independent guards: a shared token, and a
// hard loopback check so it stays unreachable from the internet even if nginx is
// ever misconfigured to forward /internal.
const INTERNAL_TOKEN = process.env.VELOX_INTERNAL_TOKEN || '';

// Loopback, and not through a proxy.
//
// The socket address alone is not the test it looks like: behind nginx every
// request arrives from 127.0.0.1, so a POST from the internet passed this check
// and only the shared token refused it. A forwarded-for header is the proxy
// saying the request came from outside, and nginx now also returns 404 for
// /internal/ — three guards, because this route hands out licences.
function isLoopback(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const proxied = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  return local && !proxied;
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

// --- YouTube cookies ---
//
// The only thing that reliably gets past "Sign in to confirm you're not a bot".
// Everything about this endpoint assumes the file is a live credential: it is
// accepted, validated and stored, and it never comes back out.

// A cookies.txt is bigger than the 32kb JSON cap and is not JSON, so this one
// route reads a text body of its own.
const cookieBody = express.text({ type: ['text/plain', 'application/json'], limit: '512kb' });

app.get('/admin/api/cookies', requireAdmin, (_req, res) => {
  res.json(ok({ cookies: ytCookies.status() }));
});

app.post('/admin/api/cookies', requireAdmin, cookieBody, (req, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) {
    return res.status(400).json({ ok: false, error: 'Paste or upload a cookies.txt file.' });
  }

  const result = ytCookies.save(text);
  if (!result.ok) {
    // The file is rejected and nothing is stored. The reason is about shape,
    // never about content.
    return res.status(400).json({ ok: false, error: result.error, problems: result.problems });
  }

  // Counts and dates only. A cookie name or value in the event log would put
  // the credential somewhere it can be read back.
  logEvent('yt-cookies-upload', null, getIp(req),
    `${result.summary.session} session cookies, expires ${result.summary.expiresAt || 'unknown'}`);
  res.json(ok({ cookies: ytCookies.status() }));
});

app.delete('/admin/api/cookies', requireAdmin, (req, res) => {
  ytCookies.clear();
  logEvent('yt-cookies-clear', null, getIp(req), '');
  res.json(ok({ cookies: ytCookies.status() }));
});

// Do they actually work? Upload without this is guesswork: the file can be
// perfectly well-formed and still be signed out, and the only way to find out
// is to ask YouTube.
app.post('/admin/api/cookies/test', requireAdmin, async (req, res) => {
  const url = typeof req.body?.url === 'string' && req.body.url.trim()
    ? req.body.url.trim()
    : 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

  const started = Date.now();
  try {
    const { probe } = require('../core/extractor');
    const info = await probe(url, {
      socketTimeout: 20,
      maxRetries: 1,
      timeoutMs: 60000,
      // The retry path's JS runtime: a cookie test that fails for want of one
      // would point at the wrong culprit.
      jsRuntime: true,
    });
    const tookMs = Date.now() - started;

    if (!info.ok) {
      const blocked = /not a bot|sign in to confirm|login required/i.test(info.error || '');
      return res.json(ok({
        test: {
          passed: false,
          blocked,
          tookMs,
          error: String(info.error || 'extraction failed').slice(0, 400),
        },
      }));
    }

    res.json(ok({
      test: {
        passed: true,
        tookMs,
        title: info.meta?.title || '',
        uploader: info.meta?.uploader || '',
        maxHeight: info.meta?.maxHeight || 0,
        qualities: (info.videoOptions || []).length,
      },
    }));
  } catch (e) {
    res.json(ok({ test: { passed: false, tookMs: Date.now() - started, error: e.message } }));
  }
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
  if (req.body?.defaultDeviceLimit !== undefined) {
    const n = Number(req.body.defaultDeviceLimit);
    if (!Number.isFinite(n) || n < 1 || n > 20) {
      return res.status(400).json({ ok: false, error: 'devices per key must be between 1 and 20' });
    }
    patch.defaultDeviceLimit = Math.floor(n);
  }
  if (req.body?.signupPerHour !== undefined) {
    const n = Number(req.body.signupPerHour);
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      return res.status(400).json({ ok: false, error: 'sign-ups per hour must be between 0 and 100000 (0 = no limit)' });
    }
    patch.signupPerHour = Math.floor(n);
  }

  stmts.saveSettings.run(patch);
  logEvent('admin-settings', null, getIp(req), JSON.stringify(patch));
  res.json(ok({ settings: settings() }));
});

// --- pricing plans ---
//
// The whole table is saved at once: the panel edits it as one list, and a plan
// that vanishes from the list is a plan that was deleted.
const PLAN_PERIODS = ['', 'one time', 'per month', 'per year', 'per week'];

app.get('/admin/api/plans', requireAdmin, (_req, res) => {
  res.json(ok({ plans: stmts.allPlans.all() }));
});

app.post('/admin/api/plans', requireAdmin, (req, res) => {
  const input = Array.isArray(req.body?.plans) ? req.body.plans : null;
  if (!input) return res.status(400).json({ ok: false, error: 'plans must be a list' });
  if (input.length > 20) return res.status(400).json({ ok: false, error: 'at most 20 plans' });

  const seen = new Set();
  const plans = [];
  for (const [i, p] of input.entries()) {
    const name = String(p?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ ok: false, error: `plan ${i + 1} needs a name` });
    const id = String(p?.id || '').trim().slice(0, 40) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (seen.has(id)) return res.status(400).json({ ok: false, error: `two plans share the id "${id}"` });
    seen.add(id);
    const period = String(p?.period || '').trim();
    if (!PLAN_PERIODS.includes(period)) return res.status(400).json({ ok: false, error: `plan "${name}" has an unknown period` });
    plans.push({
      id,
      name,
      price: String(p?.price || '').trim().slice(0, 40),
      period,
      devices: Math.min(20, Math.max(1, Math.floor(Number(p?.devices) || 1))),
      features: (Array.isArray(p?.features) ? p.features : [])
        .map((f) => String(f || '').trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 12),
      highlight: !!p?.highlight,
      active: !!p?.active,
      buyUrl: String(p?.buyUrl || '').trim().slice(0, 300),
      order: Number.isFinite(Number(p?.order)) ? Number(p.order) : i,
    });
  }
  stmts.savePlans.run(plans);
  logEvent('admin-plans', null, getIp(req), `${plans.length} plans`);
  res.json(ok({ plans: stmts.allPlans.all() }));
});

// --- broadcast notices ---
//
// Written here, delivered on the app's next heartbeat, shown as a banner (and
// a desktop notification) to whoever the audience covers.
const NOTICE_AUDIENCES = ['all', 'trial', 'trial-exhausted', 'paid', 'expired'];
const NOTICE_LEVELS = ['info', 'promo', 'warn'];

function readNotice(body) {
  const title = String(body?.title || '').trim().slice(0, 80);
  const text = String(body?.body || '').trim().slice(0, 400);
  if (!title) return { error: 'a notice needs a title' };
  const audience = String(body?.audience || 'all');
  if (!NOTICE_AUDIENCES.includes(audience)) return { error: 'unknown audience' };
  const level = String(body?.level || 'info');
  if (!NOTICE_LEVELS.includes(level)) return { error: 'unknown level' };
  const actionUrl = String(body?.actionUrl || '').trim().slice(0, 300);
  if (actionUrl && !/^https:\/\//i.test(actionUrl)) return { error: 'the button link must start with https://' };
  return {
    value: {
      title,
      body: text,
      audience,
      level,
      actionLabel: String(body?.actionLabel || '').trim().slice(0, 40),
      actionUrl,
      active: body?.active === undefined ? true : !!body.active,
    },
  };
}

app.get('/admin/api/notices', requireAdmin, (_req, res) => {
  res.json(ok({ notices: stmts.allNotices.all(), audiences: NOTICE_AUDIENCES, levels: NOTICE_LEVELS }));
});

app.post('/admin/api/notices', requireAdmin, (req, res) => {
  const parsed = readNotice(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
  if (stmts.allNotices.all().length >= 100) return res.status(400).json({ ok: false, error: 'too many notices — delete some first' });
  const notice = { id: newNoticeId(), ...parsed.value, created_at: Date.now(), updated_at: Date.now() };
  stmts.insertNotice.run(notice);
  logEvent('admin-notice-new', null, getIp(req), `${notice.audience}: ${notice.title}`);
  res.json(ok({ notice, notices: stmts.allNotices.all() }));
});

app.patch('/admin/api/notices/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '');
  const existing = stmts.allNotices.all().find((n) => n.id === id);
  if (!existing) return res.status(404).json({ ok: false, error: 'unknown notice' });
  // The active switch on its own is the common edit, so allow it alone.
  if (Object.keys(req.body || {}).length === 1 && req.body.active !== undefined) {
    stmts.updateNotice.run(id, { active: !!req.body.active });
    logEvent('admin-notice-toggle', null, getIp(req), `${id} -> ${req.body.active ? 'on' : 'off'}`);
    return res.json(ok({ notices: stmts.allNotices.all() }));
  }
  const parsed = readNotice({ ...existing, ...req.body });
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
  stmts.updateNotice.run(id, parsed.value);
  logEvent('admin-notice-edit', null, getIp(req), id);
  res.json(ok({ notices: stmts.allNotices.all() }));
});

app.delete('/admin/api/notices/:id', requireAdmin, (req, res) => {
  const r = stmts.delNotice.run(String(req.params.id || ''));
  if (!r.changes) return res.status(404).json({ ok: false, error: 'unknown notice' });
  logEvent('admin-notice-delete', null, getIp(req), String(req.params.id));
  res.json(ok({ notices: stmts.allNotices.all() }));
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

// Take one machine off its key. The key still points at a "primary" device for
// the admin table and for licences bound before the ledger existed, so when the
// machine being removed is that one, another of the key's machines takes its
// place — removing a customer's second PC must not disturb their first.
function detachDeviceFromKey(deviceId) {
  const dev = stmts.getDevice.get(deviceId);
  if (!dev || !dev.key) return dev;
  const row = stmts.findKey.get(dev.key);
  if (!row || row.device_id !== deviceId) return dev;
  const others = stmts.devicesForKey.all(dev.key).filter((d) => d.deviceId !== deviceId);
  if (others.length) {
    stmts.bindDevice.run(others[0].deviceId, others[0].name || '', row.activated_at || Date.now(), dev.key);
  } else {
    stmts.resetDevice.run(dev.key);
  }
  return dev;
}

// Free a machine so a different account can register on it. Keeps the trial
// count, so unbinding is not a way to farm new trials.
app.post('/admin/api/devices/:id/unbind', requireAdmin, (req, res) => {
  const id = String(req.params.id || '').trim();
  const dev = detachDeviceFromKey(id);
  const r = stmts.clearDeviceBinding.run(id);
  logEvent('admin-device-unbind', dev?.key || null, getIp(req), id.slice(0, 16));
  res.json(ok({ changed: r.changes }));
});

app.delete('/admin/api/devices/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '').trim();
  const dev = detachDeviceFromKey(id);
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
  if (req.body?.deviceLimit !== undefined) {
    const raw = req.body.deviceLimit;
    // Empty means "follow the plan", which is what most keys should do.
    if (raw === '' || raw === null) {
      stmts.setKeyDeviceLimit.run(key, null);
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1 || n > 20) {
        return res.status(400).json({ ok: false, error: 'devices must be between 1 and 20, or blank to follow the plan' });
      }
      stmts.setKeyDeviceLimit.run(key, n);
    }
  }
  if (req.body?.plan !== undefined) {
    const plan = String(req.body.plan || '').trim();
    if (plan && !stmts.allPlans.all().some((p) => p.id === plan)) {
      return res.status(400).json({ ok: false, error: 'unknown plan' });
    }
    stmts.setKeyPlan.run(key, plan || null);
  }
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
