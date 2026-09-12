// Both servers, the same requests, the answers compared field by field.
//
//   node server-rs/test/shadow.js
//
// parity.js proves the Rust server passes the suites the rules are written in.
// This asks a harder question: does it answer *the same way* the Node server
// does — same status, same field names, same values — for the sequence a real
// customer and a real operator actually produce? A cutover is only invisible if
// the answers are interchangeable, and the app parses these by name.
//
// Anything that cannot be equal is normalised rather than skipped: a key is
// minted at random, a token is signed at a moment in time, a timestamp is now.
// Those become placeholders, so a difference that survives is a real one.
//
// Build first: cargo build --manifest-path server-rs/Cargo.toml

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const RUST = path.join(
  ROOT,
  'server-rs/target/debug',
  process.platform === 'win32' ? 'velox-license.exe' : 'velox-license',
);
const ADMIN_PASS = 'shadow-test-pass';
const ENV = {
  ADMIN_USER: 'admin',
  ADMIN_PASS,
  VELOX_TRIAL_DOWNLOADS: '3',
  DEFAULT_LICENSE_DAYS: '30',
  VELOX_DEVICE_LIMIT: '1',
  VELOX_ACTIVATE_PER_MIN: '500',
  VELOX_HEARTBEAT_PER_MIN: '500',
  VELOX_SIGNUP_PER_HOUR: '0',
  NODE_ENV: 'test',
};

// ---------------------------------------------------------------- the steps
//
// Each step runs against both servers. `path` and `body` may be functions of
// that server's own context, because each mints its own keys.

const steps = [
  { name: 'health', method: 'GET', path: '/healthz' },
  { name: 'public pricing, fresh install', method: 'GET', path: '/api/plans' },

  // --- the operator sets the shop up -------------------------------------
  { name: 'sign in', method: 'POST', path: '/api/admin-login', body: { username: 'admin', password: ADMIN_PASS }, admin: true },
  { name: 'the seeded tiers', method: 'GET', path: '/admin/api/plans', admin: true },
  {
    name: 'price two of them',
    method: 'POST',
    path: '/admin/api/plans',
    admin: true,
    body: () => ({
      plans: [
        { id: 'monthly', name: '1 Month', price: 'LKR 999', period: 'per month', devices: 1,
          features: ['Unlimited downloads'], active: true, highlight: false, buyUrl: '', order: 1 },
        { id: 'yearly', name: '1 Year', price: 'LKR 7999', period: 'per year', devices: 2,
          features: ['Unlimited downloads', 'Two months free'], active: true, highlight: true, buyUrl: '', order: 2 },
        { id: 'lifetime', name: 'Lifetime', price: '', period: 'one time', devices: 3,
          features: [], active: false, highlight: false, buyUrl: '', order: 3 },
      ],
    }),
  },
  { name: 'public pricing now', method: 'GET', path: '/api/plans' },
  { name: 'a plan with a bad period', method: 'POST', path: '/admin/api/plans', admin: true,
    body: { plans: [{ name: 'Odd', period: 'per fortnight' }] } },
  { name: 'a plan with no name', method: 'POST', path: '/admin/api/plans', admin: true,
    body: { plans: [{ price: 'LKR 1' }] } },

  { name: 'settings as they start', method: 'GET', path: '/admin/api/settings', admin: true },
  { name: 'change the settings', method: 'POST', path: '/admin/api/settings', admin: true,
    body: { trialDownloads: 4, defaultDeviceLimit: 2, signupPerHour: 0 } },
  { name: 'a setting out of range', method: 'POST', path: '/admin/api/settings', admin: true,
    body: { trialDownloads: 99999 } },

  // --- a customer arrives ------------------------------------------------
  { name: 'sign up', method: 'POST', path: '/api/signup',
    body: { email: 'someone@example.com', deviceId: 'SHADOW-PC-1', deviceName: 'Shadow PC' },
    save: (ctx, body) => { ctx.key = body.key; } },
  { name: 'sign up again on the same machine', method: 'POST', path: '/api/signup',
    body: { email: 'someone@example.com', deviceId: 'SHADOW-PC-1', deviceName: 'Shadow PC' } },
  { name: 'sign up with a bad address', method: 'POST', path: '/api/signup',
    body: { email: 'not-an-address', deviceId: 'SHADOW-PC-1' } },
  { name: 'sign up with no machine', method: 'POST', path: '/api/signup',
    body: { email: 'nomachine@example.com' } },
  { name: 'a second account on one machine', method: 'POST', path: '/api/signup',
    body: { email: 'other@example.com', deviceId: 'SHADOW-PC-1', deviceName: 'Shadow PC' } },

  { name: 'activate', method: 'POST', path: '/api/activate',
    body: (ctx) => ({ key: ctx.key, deviceId: 'SHADOW-PC-1', deviceName: 'Shadow PC' }),
    save: (ctx, body) => { ctx.token = body.token; } },
  { name: 'activate again', method: 'POST', path: '/api/activate',
    body: (ctx) => ({ key: ctx.key, deviceId: 'SHADOW-PC-1', deviceName: 'Shadow PC' }) },
  { name: 'activate an unknown key', method: 'POST', path: '/api/activate',
    body: { key: 'VLX-NOPE1-NOPE2-NOPE3', deviceId: 'SHADOW-PC-1' } },
  { name: 'activate with nothing', method: 'POST', path: '/api/activate', body: {} },
  { name: 'activate a key on a second machine', method: 'POST', path: '/api/activate',
    body: (ctx) => ({ key: ctx.key, deviceId: 'SHADOW-PC-2', deviceName: 'Laptop' }),
    save: (ctx, body) => { ctx.second = body.token; } },

  // A machine that is on the key, but not the key's *primary* one: both servers
  // have to let it through, because the device allowance is what the plans are
  // sold on. The url is rubbish on purpose, so neither spends a download proving
  // it. This one found a live bug - the Node extraction gate was comparing the
  // token against the primary machine and refusing every second PC.
  { name: "a second machine at the extraction gate", method: "POST", path: "/api/extract",
    body: (ctx) => ({ url: "not a url", token: ctx.second }) },

  { name: 'heartbeat', method: 'POST', path: '/api/heartbeat', body: (ctx) => ({ token: ctx.token }) },
  { name: 'heartbeat with no token', method: 'POST', path: '/api/heartbeat', body: {} },
  { name: 'heartbeat with a forged token', method: 'POST', path: '/api/heartbeat', body: { token: 'not.a.token' } },

  // --- the operator looks after them --------------------------------------
  { name: 'the key table', method: 'GET', path: '/admin/api/keys', admin: true },
  { name: 'the device table', method: 'GET', path: '/admin/api/devices', admin: true },
  { name: 'put the key on a plan', method: 'PATCH', path: (ctx) => `/admin/api/keys/${ctx.key}`, admin: true,
    body: { plan: 'yearly' } },
  { name: 'put it on a plan that does not exist', method: 'PATCH', path: (ctx) => `/admin/api/keys/${ctx.key}`, admin: true,
    body: { plan: 'no-such-plan' } },
  { name: 'give it its own allowance', method: 'PATCH', path: (ctx) => `/admin/api/keys/${ctx.key}`, admin: true,
    body: { deviceLimit: 3 } },
  { name: 'an impossible allowance', method: 'PATCH', path: (ctx) => `/admin/api/keys/${ctx.key}`, admin: true,
    body: { deviceLimit: 99 } },
  { name: 'hand the allowance back to the plan', method: 'PATCH', path: (ctx) => `/admin/api/keys/${ctx.key}`, admin: true,
    body: { deviceLimit: '' } },
  { name: 'change the address', method: 'PATCH', path: (ctx) => `/admin/api/keys/${ctx.key}`, admin: true,
    body: { email: 'moved@example.com', note: 'moved house' } },
  { name: 'set an expiry date', method: 'PATCH', path: (ctx) => `/admin/api/keys/${ctx.key}`, admin: true,
    body: { expiresAt: '2031-01-15' } },
  { name: 'set an expiry that is not a date', method: 'PATCH', path: (ctx) => `/admin/api/keys/${ctx.key}`, admin: true,
    body: { expiresAt: 'whenever' } },
  { name: 'make it paid', method: 'POST', path: (ctx) => `/admin/api/keys/${ctx.key}/make-paid`, admin: true },
  { name: 'extend it', method: 'POST', path: (ctx) => `/admin/api/keys/${ctx.key}/extend`, admin: true, body: { days: 30 } },
  { name: 'extend by nothing', method: 'POST', path: (ctx) => `/admin/api/keys/${ctx.key}/extend`, admin: true, body: { days: 0 } },
  { name: 'extend an unknown key', method: 'POST', path: '/admin/api/keys/VLX-NOPE1-NOPE2-NOPE3/extend', admin: true, body: { days: 30 } },
  { name: 'heartbeat after the changes', method: 'POST', path: '/api/heartbeat', body: (ctx) => ({ token: ctx.token }) },

  // --- notices -----------------------------------------------------------
  { name: 'notices, empty', method: 'GET', path: '/admin/api/notices', admin: true },
  { name: 'write one', method: 'POST', path: '/admin/api/notices', admin: true,
    body: { title: 'Half price', body: 'This week only.', audience: 'paid', level: 'promo',
            actionLabel: 'See plans', actionUrl: 'https://veloxdownloader.prolanka.online/#pricing' },
    save: (ctx, body) => { ctx.notice = (body.notice && body.notice.id) || ''; } },
  { name: 'one with no title', method: 'POST', path: '/admin/api/notices', admin: true, body: { body: 'nothing' } },
  { name: 'one with an unsafe button', method: 'POST', path: '/admin/api/notices', admin: true,
    body: { title: 'Look', actionUrl: 'http://example.com' } },
  { name: 'one for nobody', method: 'POST', path: '/admin/api/notices', admin: true,
    body: { title: 'Look', audience: 'everyone' } },
  { name: 'it reaches the customer', method: 'POST', path: '/api/heartbeat', body: (ctx) => ({ token: ctx.token }) },
  { name: 'switch it off', method: 'PATCH', path: (ctx) => `/admin/api/notices/${ctx.notice}`, admin: true, body: { active: false } },
  { name: 'edit one field of it', method: 'PATCH', path: (ctx) => `/admin/api/notices/${ctx.notice}`, admin: true,
    body: { title: 'Half price - last day', active: true } },
  { name: 'edit one that is gone', method: 'PATCH', path: '/admin/api/notices/nothinghere', admin: true, body: { active: true } },
  { name: 'delete it', method: 'DELETE', path: (ctx) => `/admin/api/notices/${ctx.notice}`, admin: true },
  { name: 'delete it twice', method: 'DELETE', path: (ctx) => `/admin/api/notices/${ctx.notice}`, admin: true },

  // --- the hardware ledger -------------------------------------------------
  { name: 'forgive the trial', method: 'POST', path: '/admin/api/devices/SHADOW-PC-1/reset-trial', admin: true },
  { name: 'move the customer to new hardware', method: 'POST', path: (ctx) => `/admin/api/keys/${ctx.key}/reset-device`, admin: true },
  { name: 'the device table after that', method: 'GET', path: '/admin/api/devices', admin: true },
  { name: 'unbind a machine', method: 'POST', path: '/admin/api/devices/SHADOW-PC-1/unbind', admin: true },
  { name: 'delete a machine', method: 'DELETE', path: '/admin/api/devices/SHADOW-PC-2', admin: true },

  // --- taking a licence away ----------------------------------------------
  { name: 'block it', method: 'POST', path: (ctx) => `/admin/api/keys/${ctx.key}/block`, admin: true, body: { reason: 'chargeback' } },
  { name: 'a blocked key on heartbeat', method: 'POST', path: '/api/heartbeat', body: (ctx) => ({ token: ctx.token }) },
  { name: 'a blocked key on activate', method: 'POST', path: '/api/activate',
    body: (ctx) => ({ key: ctx.key, deviceId: 'SHADOW-PC-3' }) },
  { name: 'unblock it', method: 'POST', path: (ctx) => `/admin/api/keys/${ctx.key}/unblock`, admin: true },
  { name: 'revoke it', method: 'POST', path: (ctx) => `/admin/api/keys/${ctx.key}/revoke`, admin: true },
  { name: 'a revoked key on heartbeat', method: 'POST', path: '/api/heartbeat', body: (ctx) => ({ token: ctx.token }) },
  { name: 'unrevoke it', method: 'POST', path: (ctx) => `/admin/api/keys/${ctx.key}/unrevoke`, admin: true },

  // --- the gated routes ---------------------------------------------------
  { name: 'extract with no licence', method: 'POST', path: '/api/extract', body: { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' } },
  { name: 'extract with a forged token', method: 'POST', path: '/api/extract',
    body: { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', token: 'not.a.token' } },
  { name: 'resolve with no licence', method: 'POST', path: '/api/resolve', body: { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' } },
  { name: 'authorize with no licence', method: 'POST', path: '/api/authorize', body: {} },
  { name: 'a link that is not a link', method: 'POST', path: '/api/extract',
    body: (ctx) => ({ url: 'not a url', token: ctx.token }) },

  // --- the gates, with a licence in hand ----------------------------------
  { name: "authorize, first of three", method: "POST", path: "/api/authorize", body: (ctx) => ({ token: ctx.token }) },
  { name: "authorize, second", method: "POST", path: "/api/authorize", body: (ctx) => ({ token: ctx.token }) },
  { name: "authorize, third", method: "POST", path: "/api/authorize", body: (ctx) => ({ token: ctx.token }) },
  { name: "authorize once the trial is spent", method: "POST", path: "/api/authorize", body: (ctx) => ({ token: ctx.token }) },
  { name: "extract once the trial is spent", method: "POST", path: "/api/extract",
    body: (ctx) => ({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", token: ctx.token }) },
  { name: "the account screen after spending it", method: "POST", path: "/api/heartbeat", body: (ctx) => ({ token: ctx.token }) },
  { name: "forgive the trial again", method: "POST", path: "/admin/api/devices/SHADOW-PC-1/reset-trial", admin: true },

  // --- a licence that has run out -----------------------------------------
  { name: "expire the licence", method: "PATCH", path: (ctx) => `/admin/api/keys/${ctx.key}`, admin: true,
    body: { expiresAt: "2020-01-01" } },
  { name: "an expired licence on heartbeat", method: "POST", path: "/api/heartbeat", body: (ctx) => ({ token: ctx.token }) },
  { name: "an expired licence on activate", method: "POST", path: "/api/activate",
    body: (ctx) => ({ key: ctx.key, deviceId: "SHADOW-PC-1" }) },
  { name: "an expired licence at the extraction gate", method: "POST", path: "/api/authorize",
    body: (ctx) => ({ token: ctx.token }) },
  { name: "an expired licence on signup", method: "POST", path: "/api/signup",
    body: { email: "moved@example.com", deviceId: "SHADOW-PC-1" } },
  { name: "put the time back", method: "PATCH", path: (ctx) => `/admin/api/keys/${ctx.key}`, admin: true,
    body: { expiresAt: "2031-01-15" } },

  // --- a licence taken away, at every door --------------------------------
  { name: "revoke it again", method: "POST", path: (ctx) => `/admin/api/keys/${ctx.key}/revoke`, admin: true },
  { name: "a revoked licence on activate", method: "POST", path: "/api/activate",
    body: (ctx) => ({ key: ctx.key, deviceId: "SHADOW-PC-1" }) },
  { name: "a revoked licence at the extraction gate", method: "POST", path: "/api/authorize",
    body: (ctx) => ({ token: ctx.token }) },
  { name: "a revoked licence on signup", method: "POST", path: "/api/signup",
    body: { email: "moved@example.com", deviceId: "SHADOW-PC-1" } },
  { name: "unrevoke it again", method: "POST", path: (ctx) => `/admin/api/keys/${ctx.key}/unrevoke`, admin: true },

  // --- a masked address ---------------------------------------------------
  { name: "somebody else tries this machine", method: "POST", path: "/api/signup",
    body: { email: "stranger@example.com", deviceId: "SHADOW-PC-1", deviceName: "Shadow PC" } },

  // --- keys an operator makes ---------------------------------------------
  { name: 'make a key by hand', method: 'POST', path: '/admin/api/keys', admin: true,
    body: { email: 'byhand@example.com', days: 365, note: 'paid by transfer' },
    save: (ctx, body) => { ctx.handmade = body.key; } },
  { name: 'make a lifetime one', method: 'POST', path: '/admin/api/keys', admin: true,
    body: { email: 'forever@example.com', days: 0 } },
  { name: 'make one with a bad address', method: 'POST', path: '/admin/api/keys', admin: true, body: { email: 'nope' } },
  { name: 'make one with impossible days', method: 'POST', path: '/admin/api/keys', admin: true,
    body: { email: 'x@example.com', days: 99999 } },
  { name: 'delete the handmade one', method: 'DELETE', path: (ctx) => `/admin/api/keys/${ctx.handmade}`, admin: true },
  { name: 'delete it twice', method: 'DELETE', path: (ctx) => `/admin/api/keys/${ctx.handmade}`, admin: true },

  // --- the cookie jar ----------------------------------------------------
  { name: 'the jar, empty', method: 'GET', path: '/admin/api/cookies', admin: true },
  { name: 'a jar that is not one', method: 'POST', path: '/admin/api/cookies', admin: true, text: 'this is not a cookies.txt' },
  { name: 'a jar that is signed out', method: 'POST', path: '/admin/api/cookies', admin: true,
    text: '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tVISITOR_INFO1_LIVE\tabc\n' },
  { name: 'a real one', method: 'POST', path: '/admin/api/cookies', admin: true,
    text: () => {
      const expiry = Math.floor(Date.now() / 1000) + 30 * 86400;
      return (
        '# Netscape HTTP Cookie File\n' +
        `.youtube.com\tTRUE\t/\tTRUE\t${expiry}\tSID\tthe-secret\n` +
        `.youtube.com\tTRUE\t/\tTRUE\t${expiry}\t__Secure-1PSID\tanother\n` +
        `#HttpOnly_.google.com\tTRUE\t/\tTRUE\t${expiry}\tSAPISID\tthird\n`
      );
    } },
  { name: 'the jar now', method: 'GET', path: '/admin/api/cookies', admin: true },
  { name: 'take it away', method: 'DELETE', path: '/admin/api/cookies', admin: true },

  // --- what an unsigned-in stranger sees ---------------------------------
  { name: 'the key table with no session', method: 'GET', path: '/admin/api/keys' },
  { name: 'revoke with no session', method: 'POST', path: (ctx) => `/admin/api/keys/${ctx.key}/revoke` },
  { name: 'the settings with no session', method: 'GET', path: '/admin/api/settings' },
  { name: 'the store route without its token', method: 'POST', path: '/internal/issue-key',
    body: { email: 'buyer@example.com', days: 365 } },
  { name: 'sign in with the wrong password', method: 'POST', path: '/api/admin-login',
    body: { username: 'admin', password: 'wrong' } },
  { name: 'sign in as somebody else', method: 'POST', path: '/api/admin-login',
    body: { username: 'root', password: ADMIN_PASS } },
];

// -------------------------------------------------------------- normalising

/// Values that cannot be equal between two servers, replaced so that what is
/// left is comparable. A key is random, a token is signed at a moment, a
/// timestamp is now, and an uptime is an uptime.
function normalise(value, ctx) {
  if (Array.isArray(value)) return value.map((v) => normalise(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalise(value[k], ctx);
    return out;
  }
  if (typeof value === 'string') {
    let s = value;
    if (ctx.key) s = s.split(ctx.key).join('<key>');
    if (ctx.handmade) s = s.split(ctx.handmade).join('<key>');
    if (ctx.notice) s = s.split(ctx.notice).join('<notice>');
    // A JWT, and anything else that looks minted.
    if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(s)) return '<token>';
    s = s.replace(/VLX-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/g, '<key>');
    // An ISO date, and a bare epoch in a message.
    s = s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<when>');
    s = s.replace(/\b1[6-9]\d{11}\b/g, '<when>');
    return s;
  }
  if (typeof value === 'number') {
    // Any millisecond timestamp, and any second-resolution one from this decade.
    if (value > 1_600_000_000_000) return '<when>';
    if (value > 1_600_000_000 && value < 2_600_000_000) return '<when>';
    // An uptime, or a duration.
    if (!Number.isInteger(value)) return '<seconds>';
    return value;
  }
  return value;
}

/// A JSON object store can delete a field; a SQL row can only null it. Neither
/// is wrong, and nothing reading either can tell the difference, so absent and
/// null are the same thing to this comparison.
function nullish(v) {
  return v === null || v === undefined;
}

/// Rows the two servers may legitimately hand back in a different order: both
/// sort by a timestamp, and two machines touched in the same millisecond are a
/// tie that each store breaks its own way. Compared as a set, by id.
function sortRows(value) {
  if (Array.isArray(value)) {
    const rows = value.map(sortRows);
    const idOf = (r) => (r && typeof r === 'object' ? r.deviceId || r.id || r.key : undefined);
    if (rows.length > 1 && rows.every((r) => idOf(r) !== undefined)) {
      return [...rows].sort((a, b) => String(idOf(a)).localeCompare(String(idOf(b))));
    }
    return rows;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = sortRows(value[k]);
    return out;
  }
  return value;
}

/// Fields whose value is nobody's business to compare: the two servers keep
/// their own audit log, their own clock and their own id for a notice.
const IGNORED_KEYS = new Set(['uptime', 'events', 'createdAt', 'created_at', 'updated_at', 'at', 'firstSeen', 'boundAt', 'updatedAt', 'activated_at', 'last_heartbeat', 'blocked_at', 'uploadedAt', 'bytes', 'tookMs', 'retryAfterMinutes']);

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (IGNORED_KEYS.has(k)) continue;
      out[k] = strip(value[k]);
    }
    return out;
  }
  return value;
}

function differences(a, b, trail = '') {
  const out = [];
  const both = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of both) {
    const here = trail ? `${trail}.${k}` : k;
    const x = a ? a[k] : undefined;
    const y = b ? b[k] : undefined;
    const shape = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    if (shape(x) === 'object' && shape(y) === 'object') {
      out.push(...differences(x, y, here));
    } else if (shape(x) === 'array' && shape(y) === 'array') {
      if (x.length !== y.length) out.push(`${here}: node has ${x.length}, rust has ${y.length}`);
      else for (let i = 0; i < x.length; i += 1) out.push(...differences({ [i]: x[i] }, { [i]: y[i] }, here));
    } else if (nullish(x) && nullish(y)) {
      // absent on one side, null on the other: the same absence
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      out.push(`${here}: node ${JSON.stringify(x)} vs rust ${JSON.stringify(y)}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------- driving

function startNode(port, data) {
  return spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    cwd: ROOT,
    env: { ...process.env, ...ENV, PORT: String(port), DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function startRust(port, data) {
  return spawn(RUST, [], {
    cwd: path.join(ROOT, 'server-rs'),
    env: { ...process.env, ...ENV, PORT: String(port), DATA_DIR: data, RUST_LOG: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitFor(base) {
  for (let i = 0; i < 160; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function run(server, step) {
  const pathname = typeof step.path === 'function' ? step.path(server.ctx) : step.path;
  const raw = typeof step.text === 'function' ? step.text() : step.text;
  const body = typeof step.body === 'function' ? step.body(server.ctx) : step.body;

  const headers = {};
  if (raw !== undefined) headers['content-type'] = 'text/plain';
  else if (body !== undefined) headers['content-type'] = 'application/json';
  if (server.cookie) headers.cookie = server.cookie;

  const res = await fetch(server.base + pathname, {
    method: step.method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && step.admin) server.cookie = setCookie.split(';')[0];

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (step.save && json) step.save(server.ctx, json);
  return { status: res.status, body: json };
}

(async () => {
  if (!fs.existsSync(RUST)) {
    console.error(`No Rust server at ${RUST}\nRun: cargo build --manifest-path server-rs/Cargo.toml`);
    process.exit(1);
  }

  const nodeData = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-shadow-node-'));
  const rustData = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-shadow-rust-'));
  const node = { name: 'node', base: 'http://127.0.0.1:4221', proc: startNode(4221, nodeData), ctx: {}, cookie: '' };
  const rust = { name: 'rust', base: 'http://127.0.0.1:4222', proc: startRust(4222, rustData), ctx: {}, cookie: '' };
  for (const s of [node, rust]) {
    s.log = '';
    s.proc.stdout.on('data', (d) => { s.log += d; });
    s.proc.stderr.on('data', (d) => { s.log += d; });
  }

  let same = 0;
  let known = 0;
  const mismatches = [];
  try {
    for (const s of [node, rust]) {
      if (!(await waitFor(s.base))) throw new Error(`the ${s.name} server never came up:\n${s.log}`);
    }

    for (const step of steps) {
      const a = await run(node, step);
      const b = await run(rust, step);

      if (step.dump) {
        const shrink = (r) => ({ key: r.key, expires_at: r.expires_at, status: r.status, days: r.days_remaining, trial: r.trial, devs: r.devices_used });
        console.log("  node:", JSON.stringify((a.body.keys || []).map(shrink)));
        console.log("  rust:", JSON.stringify((b.body.keys || []).map(shrink)));
        continue;
      }
      const left = sortRows(strip(normalise(a.body, node.ctx)));
      const right = sortRows(strip(normalise(b.body, rust.ctx)));
      const problems = [];
      if (a.status !== b.status) problems.push(`status: node ${a.status} vs rust ${b.status}`);
      problems.push(...differences(left, right));

      // Some answers are meant to differ, and the reason is written on the step.
      if (step.known) {
        known += 1;
        console.log(`note  ${step.method} ${step.name}`);
        console.log(`        on purpose: ${step.known}`);
        for (const p of problems.slice(0, 4)) console.log(`        ${p}`);
        if (!problems.length) console.log('        but they agreed - the note may be out of date');
        continue;
      }

      if (problems.length) {
        mismatches.push({ step: step.name, method: step.method, problems });
        console.log(`DIFF  ${step.method} ${step.name}`);
        for (const p of problems.slice(0, 8)) console.log(`        ${p}`);
        if (problems.length > 8) console.log(`        ... and ${problems.length - 8} more`);
      } else {
        same += 1;
        console.log(`same  ${step.method} ${step.name}`);
      }
    }
  } catch (e) {
    console.error(`\nharness: ${e.message}`);
    mismatches.push({ step: 'harness', problems: [e.message] });
  } finally {
    node.proc.kill();
    rust.proc.kill();
  }

  console.log(`\n${same} of ${steps.length} answers identical, ${mismatches.length} differ`);
  process.exitCode = mismatches.length ? 1 : 0;
})();
