// The cutover rehearsal, on the server, against the real ledger.
//
//   node server-rs/test/live-rehearsal.js
//
// Run on the VPS. It asks the live Node server and a Rust server holding an
// imported copy of the same ledger the same READ-ONLY questions, and compares
// the answers. Nothing here writes to either: no keys are issued, no plan is
// edited, no licence is touched. The Rust server is started on a port nothing
// routes to, bound to localhost, with its own data directory.
//
// This is the last check before traffic moves. parity.js and shadow.js prove the
// behaviour on invented data; this proves it on the keys people actually paid
// for, with the settings this shop actually runs.
//
//   Set up first:
//     ./target/release/import /root/velox-rs-trial/licenses.json \
//                             /root/velox-rs-trial/licenses.db

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LIVE = process.env.VELOX_LIVE_BASE || 'http://127.0.0.1:4010';
const PORT = Number(process.env.VELOX_TRIAL_PORT || 4011);
const TRIAL = `http://127.0.0.1:${PORT}`;
const DATA = process.env.VELOX_TRIAL_DATA || '/root/velox-rs-trial';
const RUST = process.env.VELOX_RUST_BIN || '/opt/velox/server-rs/target/release/velox-license';
const ENV_FILE = process.env.VELOX_ENV_FILE || '/opt/velox/server/.env';

// Only GETs, and only the ones that change nothing. The live server is serving
// customers while this runs.
const READS = [
  { name: 'health', path: '/healthz' },
  { name: 'the published pricing', path: '/api/plans' },
  { name: 'the key table', path: '/admin/api/keys', admin: true },
  { name: 'the device ledger', path: '/admin/api/devices', admin: true },
  { name: 'the settings', path: '/admin/api/settings', admin: true },
  { name: 'the pricing editor', path: '/admin/api/plans', admin: true },
  { name: 'the notices', path: '/admin/api/notices', admin: true },
  { name: 'the cookie jar', path: '/admin/api/cookies', admin: true },
];

/// Read ADMIN_USER and ADMIN_PASS out of the server's own .env, so the password
/// is never typed on a command line or printed.
function credentials() {
  const out = { user: 'admin', pass: '' };
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (m[1] === 'ADMIN_USER' && value) out.user = value;
    if (m[1] === 'ADMIN_PASS') out.pass = value;
  }
  return out;
}

/// An HS256 token, the same shape the licence server signs: no library, because
/// this script runs on the server and should need nothing installed.
function signToken(claims, secret) {
  const crypto = require('crypto');
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...claims, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const signature = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

let pass = 0;
let fail = 0;
const check = (ok, name, detail) => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

async function signIn(base, who) {
  const res = await fetch(`${base}/api/admin-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: who.user, password: who.pass }),
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return res.ok && cookie ? cookie : '';
}

async function read(base, cookie, route) {
  const res = await fetch(base + route.path, { headers: route.admin ? { cookie } : {} });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// What cannot be equal: the process uptime, and the moment a file was written.
const VOLATILE = new Set(['uptime', 'uploadedAt', 'bytes', 'last_heartbeat', 'updatedAt']);

function tidy(value) {
  if (Array.isArray(value)) {
    const rows = value.map(tidy);
    const id = (r) => (r && typeof r === 'object' ? r.deviceId || r.id || r.key : undefined);
    if (rows.length > 1 && rows.every((r) => id(r) !== undefined)) {
      return [...rows].sort((a, b) => String(id(a)).localeCompare(String(id(b))));
    }
    return rows;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE.has(k)) continue;
      out[k] = tidy(value[k]);
    }
    return out;
  }
  return value;
}

function differences(a, b, trail = '') {
  const out = [];
  const shape = (v) => (Array.isArray(v) ? 'array' : v === null || v === undefined ? 'nothing' : typeof v);
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const here = trail ? `${trail}.${k}` : k;
    const x = a ? a[k] : undefined;
    const y = b ? b[k] : undefined;
    if (shape(x) === 'nothing' && shape(y) === 'nothing') continue;
    if (shape(x) === 'object' && shape(y) === 'object') out.push(...differences(x, y, here));
    else if (shape(x) === 'array' && shape(y) === 'array') {
      if (x.length !== y.length) out.push(`${here}: live has ${x.length}, rust has ${y.length}`);
      else for (let i = 0; i < x.length; i += 1) out.push(...differences({ [i]: x[i] }, { [i]: y[i] }, here));
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      out.push(`${here}: live ${JSON.stringify(x)} vs rust ${JSON.stringify(y)}`);
    }
  }
  return out;
}

(async () => {
  const who = credentials();
  if (!who.pass) {
    console.error(`No ADMIN_PASS in ${ENV_FILE} - the admin comparisons need it.`);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(DATA, 'licenses.db'))) {
    console.error(`No imported ledger at ${DATA}/licenses.db - run the importer first.`);
    process.exit(2);
  }

  const rust = spawn(RUST, [], {
    cwd: '/opt/velox/server-rs',
    env: {
      ...process.env,
      PORT: String(PORT),
      BIND_ADDR: '127.0.0.1',
      DATA_DIR: DATA,
      ADMIN_USER: who.user,
      ADMIN_PASS: who.pass,
      PUBLIC_DIR: '/opt/velox/server/public',
      RUST_LOG: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  rust.stdout.on('data', (d) => { log += d; });
  rust.stderr.on('data', (d) => { log += d; });

  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i += 1) {
      try { up = (await fetch(`${TRIAL}/healthz`)).ok; } catch { /* not yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    check(up, 'the rust server starts on the imported ledger', log.split('\n').slice(-6).join('\n'));
    if (!up) return;

    const liveCookie = await signIn(LIVE, who);
    const trialCookie = await signIn(TRIAL, who);
    check(!!liveCookie, 'the panel password signs in to the live server');
    check(!!trialCookie, 'and to the rust one, with the same password');

    for (const route of READS) {
      const a = await read(LIVE, liveCookie, route);
      const b = await read(TRIAL, trialCookie, route);
      const problems = [];
      if (a.status !== b.status) problems.push(`status: live ${a.status} vs rust ${b.status}`);
      problems.push(...differences(tidy(a.body), tidy(b.body)));
      check(problems.length === 0, `${route.name} reads the same`, problems.slice(0, 6).join('\n         '));
    }

    // The one thing worth proving beyond equality: a token carrying the live
    // server's signature is accepted by the Rust one. That is what makes the
    // cutover invisible to an app that is running while it happens.
    //
    // The token is signed here from the shared secret rather than asked for from
    // the live server: activating would bind a device and write to the ledger,
    // and this rehearsal does not write to live data.
    const keys = (await read(TRIAL, trialCookie, { path: '/admin/api/keys', admin: true })).body;
    const real = (keys.keys || []).find((k) => k.device_id && k.status === 'active');
    if (!real) {
      console.log('  note  no active key with a machine in the ledger - skipping the token check');
    } else {
      const minted = signToken(
        { key: real.key, deviceId: real.device_id, email: real.email || undefined },
        fs.readFileSync(path.join(DATA, '.jwt-secret'), 'utf8').trim(),
      );
      const beat = await fetch(`${TRIAL}/api/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: minted }),
      });
      const body = await beat.json().catch(() => ({}));
      check(beat.ok && body.ok === true,
        "a token with the live server's signature is accepted - a running app would not notice the cutover",
        `${beat.status} ${JSON.stringify(body).slice(0, 200)}`);
      check(!!body.token && body.token !== minted, 'and the beat hands back a fresh one, as it always did');
      check(
        !!body.profile && body.profile.key === real.key && Array.isArray(body.plans),
        'the account screen it answers with is the real one',
        JSON.stringify(body.profile || {}).slice(0, 200),
      );
    }
  } catch (e) {
    check(false, `the rehearsal ran to the end`, e.message);
  } finally {
    rust.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail && log.trim()) console.log(`\nrust log:\n${log.split('\n').slice(-15).join('\n')}`);
  process.exitCode = fail ? 1 : 0;
})();
