// How many machines one licence may run on
//
// Run against the Node server:      npm test          (in server/)
// Run against any other build:      VELOX_TEST_BASE=http://127.0.0.1:4011 npm test
//
// The second form is the point of these tests. They do not check one
// implementation against itself — they check the rules the business depends on
// (who may activate, how many machines, what a trial spends, which notice
// reaches whom) against whatever is serving them. A rewrite in another language
// is finished when these pass unchanged.
//
// Against an external server, start that server with VELOX_ACTIVATE_PER_MIN
// and VELOX_HEARTBEAT_PER_MIN raised — this suite activates dozens of machines
// in seconds and the per-IP limiter will otherwise refuse the burst.
//
// With VELOX_TEST_BASE the suite starts nothing: point it at a server with its
// own throwaway data directory, because it writes keys, plans and notices.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJ = path.join(__dirname, '..', '..');
const DATA = path.join(os.tmpdir(), 'velox-test-devices-' + Date.now());
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const PORT = 4141;
const EXTERNAL = process.env.VELOX_TEST_BASE || "";
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const ADMIN_PASS = 'dev-test-pass';

let failures = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  [' + extra + ']' : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function call(p, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
const activate = (key, device) =>
  call('/api/activate', { method: 'POST', body: { key, deviceId: device, deviceName: device + ' PC' } });
const beat = (token) => call('/api/heartbeat', { method: 'POST', body: { token } });

const server = EXTERNAL ? { kill() {}, stdout: { on() {} }, stderr: { on() {} }, on() {} } : spawn(process.execPath, [path.join(PROJ, 'server', 'server.js')], {
  cwd: PROJ,
  env: {
    ...process.env,
    PORT: String(PORT), DATA_DIR: DATA, ADMIN_USER: 'admin', ADMIN_PASS,
    // This suite activates dozens of machines in a few seconds, which the
    // per-IP limiter is right to refuse in production and wrong to refuse here.
    VELOX_ACTIVATE_PER_MIN: '500',
    VELOX_HEARTBEAT_PER_MIN: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stop = () => { try { server.kill(); } catch {} };

// Exiting while the spawned server is still being torn down trips a libuv
// assertion on Windows, which turned a passing run into a failing exit code.
// Setting exitCode and letting the loop drain avoids the race.
function finish(code) {
  stop();
  process.exitCode = code;
}

(async () => {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) break; } catch {}
    await wait(100);
  }
  await call('/api/admin-login', { method: 'POST', body: { username: 'admin', password: ADMIN_PASS } });

  // --- the panel opens with the three tiers to edit ---
  const seeded = (await call('/admin/api/plans')).body.plans;
  check(seeded.map((p) => p.name).join(', ') === '1 Month, 1 Year, Lifetime',
    'the panel starts with the three tiers ready to price', seeded.map((p) => p.name).join(', '));
  check(seeded.every((p) => !p.active && !p.price),
    'they are unpriced and unpublished, so nothing ships by accident');
  check(seeded.map((p) => p.devices).join(',') === '1,2,3',
    'each tier carries its own device allowance', seeded.map((p) => `${p.name}:${p.devices}`).join(' '));

  // --- 1. the old rule still holds by default: one machine ---
  const k1 = (await call('/admin/api/keys', { method: 'POST', body: { email: 'one@example.com', days: 30 } })).body.key;
  const a1 = await activate(k1, 'DEV-A');
  check(a1.status === 200, 'the first machine activates');
  const a1b = await activate(k1, 'DEV-B');
  check(a1b.status === 409 && a1b.body.deviceMismatch, 'a second machine is refused on a one-device key', a1b.body?.error);
  check(a1b.body.error.includes('already connected with another device'),
    'and the wording is the one customers already know');
  check(a1.body.profile.devices.used === 1 && a1.body.profile.devices.limit === 1,
    'the app is told 1 of 1 devices', JSON.stringify(a1.body.profile.devices));

  // --- 2. a plan with a bigger allowance ---
  await call('/admin/api/plans', {
    method: 'POST',
    body: {
      plans: [
        { id: 'monthly', name: '1 Month', price: 'LKR 990', period: 'per month', devices: 1, active: true, order: 1, features: [] },
        { id: 'yearly', name: '1 Year', price: 'LKR 7900', period: 'per year', devices: 2, active: true, order: 2, features: [] },
        { id: 'lifetime', name: 'Lifetime', price: 'LKR 14900', period: 'one time', devices: 3, active: true, order: 3, features: [] },
      ],
    },
  });
  const k3 = (await call('/admin/api/keys', { method: 'POST', body: { email: 'three@example.com', days: 0 } })).body.key;
  await call(`/admin/api/keys/${k3}`, { method: 'PATCH', body: { email: 'three@example.com', plan: 'lifetime' } });

  const t1 = await activate(k3, 'PC-1');
  const t2 = await activate(k3, 'PC-2');
  const t3 = await activate(k3, 'PC-3');
  check(t1.status === 200 && t2.status === 200 && t3.status === 200,
    'a Lifetime key runs on all three of its machines', `${t1.status}/${t2.status}/${t3.status}`);
  check(t3.body.profile.devices.used === 3 && t3.body.profile.devices.limit === 3,
    'and reports 3 of 3', JSON.stringify(t3.body.profile.devices));

  const t4 = await activate(k3, 'PC-4');
  check(t4.status === 409, 'the fourth machine is refused', t4.body?.error);
  check(/3 of 3 devices/.test(t4.body.error || ''), 'the refusal says how many are in use', t4.body?.error);

  // --- 3. all three machines keep working ---
  const beats = await Promise.all([t1, t2, t3].map((r) => beat(r.body.token)));
  check(beats.every((b) => b.status === 200), 'every registered machine keeps its heartbeat',
    beats.map((b) => b.status).join('/'));

  // --- 4. raising the plan lifts every key already sold on it ---
  await call('/admin/api/plans', {
    method: 'POST',
    body: { plans: [{ id: 'lifetime', name: 'Lifetime', price: 'LKR 14900', period: 'one time', devices: 4, active: true, order: 1, features: [] }] },
  });
  const t4b = await activate(k3, 'PC-4');
  check(t4b.status === 200, 'raising the plan to 4 lets the fourth machine in, with no key edits');
  check(t4b.body.profile.devices.limit === 4, 'the new allowance shows in the profile',
    JSON.stringify(t4b.body.profile.devices));

  // --- 5. a per-key override beats the plan ---
  const pinned = await call(`/admin/api/keys/${k3}`, { method: 'PATCH', body: { email: 'three@example.com', deviceLimit: 2 } });
  check(pinned.status === 200, 'an admin can pin one key to its own number');
  const t5 = await activate(k3, 'PC-5');
  check(t5.status === 409, 'the override is what counts, even below what is already bound', t5.body?.error);
  const back = await call(`/admin/api/keys/${k3}`, { method: 'PATCH', body: { email: 'three@example.com', deviceLimit: '' } });
  check(back.status === 200, 'clearing the override is allowed');
  const t5b = await activate(k3, 'PC-5');
  check(t5b.status === 409 && /4 of 4/.test(t5b.body.error || ''),
    'and the key follows its plan again', t5b.body?.error);

  const bad = await call(`/admin/api/keys/${k3}`, { method: 'PATCH', body: { email: 'three@example.com', deviceLimit: 99 } });
  check(bad.status === 400, 'a silly device number is refused', bad.body?.error);

  // --- 6. unbinding a machine takes it away at the next heartbeat ---
  const before = await beat(t2.body.token);
  check(before.status === 200, 'PC-2 is fine before it is unbound');
  await call('/admin/api/devices/PC-2/unbind', { method: 'POST' });
  const after = await beat(before.body.token);
  check(after.status === 409, 'once unbound, that machine stops working', `status ${after.status}`);
  const stillOk = await beat(t1.body.token);
  check(stillOk.status === 200, 'while the other machines carry on', `status ${stillOk.status}`);

  // --- 7. removing the FIRST machine leaves the rest alone ---
  const primaryGone = await call('/admin/api/devices/PC-1', { method: 'DELETE' });
  check(primaryGone.status === 200, 'the first machine can be removed');
  const t3Beat = await beat(t3.body.token);
  check(t3Beat.status === 200, 'the other machines carry on after the first is removed', `status ${t3Beat.status}`);
  const promoted = (await call('/admin/api/keys')).body.keys.find((k) => k.key === k3);
  check(!!promoted.device_id && promoted.device_id !== 'PC-1',
    'and the key now points at one of the machines that is left', promoted.device_id || 'none');

  // --- 8. one machine still belongs to one account ---
  const other = (await call('/admin/api/keys', { method: 'POST', body: { email: 'other@example.com', days: 30 } })).body.key;
  const taken = await activate(other, 'PC-3');
  check(taken.status === 409 && taken.body.deviceTaken,
    'a machine already registered to someone else is still refused', taken.body?.error);

  // --- 9. the fallback for keys with no plan is a setting ---
  await call('/admin/api/settings', { method: 'POST', body: { defaultDeviceLimit: 2 } });
  const kDef = (await call('/admin/api/keys', { method: 'POST', body: { email: 'def@example.com', days: 30 } })).body.key;
  const d1 = await activate(kDef, 'DEF-1');
  const d2 = await activate(kDef, 'DEF-2');
  const d3 = await activate(kDef, 'DEF-3');
  check(d1.status === 200 && d2.status === 200 && d3.status === 409,
    'the default allowance applies to keys with no plan', `${d1.status}/${d2.status}/${d3.status}`);
  const badSetting = await call('/admin/api/settings', { method: 'POST', body: { defaultDeviceLimit: 0 } });
  check(badSetting.status === 400, 'zero devices is refused as a setting', badSetting.body?.error);

  // --- 10. the panel can see the usage ---
  const keys = (await call('/admin/api/keys')).body.keys;
  const shown = keys.find((k) => k.key === kDef);
  check(shown.devices_used === 2 && shown.devices_limit === 2,
    'the keys table knows how many machines each key is on',
    `${shown.devices_used}/${shown.devices_limit}`);

  console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'}`);
  finish(failures ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASHED:', e.message, '\n', (e.stack || '').split('\n').slice(0, 4).join('\n'));
  finish(2);
});
