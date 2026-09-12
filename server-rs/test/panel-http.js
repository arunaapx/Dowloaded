// The panel itself, against the real binary.
//
//   node server-rs/test/panel-http.js
//
// tests/admin.rs drives the same router in process; this runs the built server
// as a person would, so it also covers the things only the real process does:
// reading the panel off disk, seeding the pricing tiers on a fresh install, and
// refusing the store service route when no token is configured.
//
// Build first: cargo build --manifest-path server-rs/Cargo.toml
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 4213;
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'panel-smoke-pass';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-panel-'));
// The debug build by default, because that is what a developer has just built.
// VELOX_RUST_BIN points it at the release binary, which is what the server runs.
const BINARY = process.env.VELOX_RUST_BIN || path.join(
  ROOT,
  'server-rs/target/debug',
  process.platform === 'win32' ? 'velox-license.exe' : 'velox-license',
);

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

(async () => {
  const server = spawn(BINARY, [], {
    cwd: path.join(ROOT, 'server-rs'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: data, ADMIN_USER: 'admin', ADMIN_PASS: PASS, RUST_LOG: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
  );
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  try {
    for (let i = 0; i < 120; i += 1) {
      try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }

    // Nobody signed in.
    const cold = await fetch(`${BASE}/admin/`, { redirect: 'manual' });
    check('the panel redirects a stranger to the sign-in page', cold.status === 303 || cold.status === 302 || cold.status === 307,
      `${cold.status} ${cold.headers.get('location')}`);
    check('and it points at /login', (cold.headers.get('location') || '').includes('/login'));

    const js = await fetch(`${BASE}/admin/admin.js`, { redirect: 'manual' });
    check('the panel JS is not readable either', js.status !== 200, String(js.status));

    const root = await fetch(`${BASE}/`, { redirect: 'manual' });
    check('/ sends a stranger to sign in', (root.headers.get('location') || '').includes('/login'));

    const login = await fetch(`${BASE}/login`);
    const html = await login.text();
    check('the sign-in page itself is public', login.ok && /velox/i.test(html), String(login.status));
    const css = await fetch(`${BASE}/admin/admin.css`);
    check('and the stylesheet it needs', css.ok && (css.headers.get('content-type') || '').includes('css'));

    // Signed in.
    const res = await fetch(`${BASE}/api/admin-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASS }),
    });
    const setCookie = res.headers.get('set-cookie') || '';
    check('signing in sets an HttpOnly SameSite cookie', res.ok && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie);
    const cookie = setCookie.split(';')[0];

    const panel = await fetch(`${BASE}/admin/`, { headers: { cookie } });
    const panelHtml = await panel.text();
    check('the panel opens with a session', panel.ok && /<html/i.test(panelHtml), String(panel.status));
    check('it is the real panel', /admin\.js/.test(panelHtml));

    for (const route of ['/admin/api/keys', '/admin/api/devices', '/admin/api/settings', '/admin/api/plans', '/admin/api/notices', '/admin/api/events', '/admin/api/cookies']) {
      const r = await fetch(BASE + route, { headers: { cookie } });
      const body = await r.json().catch(() => ({}));
      check(`${route} answers the panel`, r.ok && body.ok === true, `${r.status} ${JSON.stringify(body).slice(0, 120)}`);
    }

    // The seeded tiers are there to edit.
    const plans = await (await fetch(`${BASE}/admin/api/plans`, { headers: { cookie } })).json();
    check('the three tiers are waiting to be priced', (plans.plans || []).length === 3 && plans.plans.every((p) => !p.active),
      JSON.stringify((plans.plans || []).map((p) => p.name)));

    // And the public pricing shows none of them until someone prices one.
    const pub1 = await (await fetch(`${BASE}/api/plans`)).json();
    check('the website is shown nothing unfinished', (pub1.plans || []).length === 0);

    const published = plans.plans.map((p) => (p.id === 'yearly' ? { ...p, price: 'LKR 7999', active: true } : p));
    await fetch(`${BASE}/admin/api/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ plans: published }),
    });
    const pub2 = await (await fetch(`${BASE}/api/plans`)).json();
    check('pricing one tier publishes exactly that one', (pub2.plans || []).length === 1 && pub2.plans[0].price === 'LKR 7999',
      JSON.stringify(pub2.plans));

    // The store service's route: no token configured here, so it must refuse.
    const internal = await fetch(`${BASE}/internal/issue-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'buyer@example.com', days: 365 }),
    });
    check('the internal route is off when no token is set', internal.status === 503, String(internal.status));
  } catch (e) {
    fail += 1;
    console.log(`  FAIL harness -> ${e.message}`);
  } finally {
    server.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(`\nserver log:\n${log.split('\n').slice(-20).join('\n')}`);
  process.exitCode = fail ? 1 : 0;
})();
