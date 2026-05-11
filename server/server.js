require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { customAlphabet } = require('nanoid');
const { db, stmts, logEvent } = require('./db');

const PORT = parseInt(process.env.PORT || '4000', 10);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const TOKEN_TTL_HOURS = parseInt(process.env.TOKEN_TTL_HOURS || '24', 10);

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
  if (!emailOk(email)) return res.status(400).json({ ok: false, error: 'invalid email' });

  const existing = stmts.findEmail.get(email);
  if (existing) {
    if (existing.revoked) {
      logEvent('signup-revoked-attempt', existing.key, getIp(req), email);
      return res.status(403).json({ ok: false, error: 'key revoked' });
    }
    logEvent('signup-existing', existing.key, getIp(req), email);
    return res.json(ok({ key: existing.key, message: 'existing key returned' }));
  }

  const key = makeKey();
  stmts.insertKey.run(key, email, Date.now(), 'self-signup');
  logEvent('signup', key, getIp(req), email);
  res.json(ok({ key }));
});

app.post('/api/activate', activateLimit, (req, res) => {
  const key = String(req.body?.key || '').trim();
  const deviceId = String(req.body?.deviceId || '').trim();
  const deviceName = String(req.body?.deviceName || '').trim().slice(0, 100);

  if (!key || !deviceId) return res.status(400).json({ ok: false, error: 'missing fields' });

  const row = stmts.findKey.get(key);
  if (!row) {
    logEvent('activate-unknown-key', key, getIp(req), deviceId);
    return res.status(404).json({ ok: false, error: 'unknown key' });
  }
  if (row.revoked) {
    logEvent('activate-revoked', key, getIp(req), deviceId);
    return res.status(403).json({ ok: false, error: 'key revoked' });
  }
  if (row.device_id && row.device_id !== deviceId) {
    logEvent('activate-conflict', key, getIp(req), `bound:${row.device_id} vs ${deviceId}`);
    return res.status(409).json({ ok: false, error: 'key already activated on another device' });
  }
  if (!row.device_id) {
    stmts.bindDevice.run(deviceId, deviceName, Date.now(), key);
    logEvent('activate', key, getIp(req), `${deviceName} / ${deviceId}`);
  } else {
    logEvent('reactivate', key, getIp(req), deviceId);
  }

  const token = jwt.sign(
    { key, deviceId, email: row.email },
    JWT_SECRET,
    { expiresIn: `${TOKEN_TTL_HOURS}h` }
  );
  res.json(ok({ token, email: row.email, expiresIn: TOKEN_TTL_HOURS * 3600 }));
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
  if (row.revoked) {
    logEvent('heartbeat-revoked', payload.key, getIp(req), payload.deviceId);
    return res.status(403).json({ ok: false, error: 'key revoked', revoked: true });
  }
  if (row.device_id && payload.deviceId !== row.device_id) {
    return res.status(409).json({ ok: false, error: 'device mismatch' });
  }
  stmts.bumpHeartbeat.run(Date.now(), payload.key);
  res.json(ok({ revoked: false }));
});

// --- admin API ---

app.get('/admin/api/keys', requireAdmin, (_req, res) => {
  res.json({ ok: true, keys: stmts.allKeys.all() });
});

app.get('/admin/api/events', requireAdmin, (_req, res) => {
  res.json({ ok: true, events: stmts.recentEvents.all() });
});

app.post('/admin/api/keys', requireAdmin, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const note  = String(req.body?.note || 'admin-created').trim().slice(0, 200);
  if (email && !emailOk(email)) return res.status(400).json({ ok: false, error: 'invalid email' });
  const key = makeKey();
  stmts.insertKey.run(key, email || null, Date.now(), note);
  logEvent('admin-create', key, getIp(req), email);
  res.json(ok({ key }));
});

app.post('/admin/api/keys/:key/revoke', requireAdmin, (req, res) => {
  const r = stmts.revoke.run(req.params.key);
  logEvent('admin-revoke', req.params.key, getIp(req), '');
  res.json(ok({ changed: r.changes }));
});

app.post('/admin/api/keys/:key/unrevoke', requireAdmin, (req, res) => {
  const r = stmts.unrevoke.run(req.params.key);
  logEvent('admin-unrevoke', req.params.key, getIp(req), '');
  res.json(ok({ changed: r.changes }));
});

app.post('/admin/api/keys/:key/reset-device', requireAdmin, (req, res) => {
  const r = stmts.resetDevice.run(req.params.key);
  logEvent('admin-reset-device', req.params.key, getIp(req), '');
  res.json(ok({ changed: r.changes }));
});

app.delete('/admin/api/keys/:key', requireAdmin, (req, res) => {
  const r = stmts.delKey.run(req.params.key);
  logEvent('admin-delete', req.params.key, getIp(req), '');
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
