// Plans, notices and what a customer is allowed to see
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
// With VELOX_TEST_BASE the suite starts nothing: point it at a server with its
// own throwaway data directory, because it writes keys, plans and notices.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJ = path.join(__dirname, '..', '..');
const DATA = path.join(os.tmpdir(), 'velox-test-licensing-' + Date.now());
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const PORT = 4111;
const EXTERNAL = process.env.VELOX_TEST_BASE || "";
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const ADMIN_PASS = 'test-pass-123';

let failures = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  [' + extra + ']' : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function call(pathname, { method = 'GET', body, admin = false } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(admin && cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

const server = EXTERNAL ? { kill() {}, stdout: { on() {} }, stderr: { on() {} }, on() {} } : spawn(process.execPath, [path.join(PROJ, 'server', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: DATA,
    ADMIN_USER: 'admin',
    ADMIN_PASS,
    VELOX_TRIAL_DOWNLOADS: '3',
    NODE_ENV: 'test',
  },
  cwd: PROJ,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
server.on('error', (e) => { serverLog += 'SPAWN ERROR: ' + e.message; });
server.on('exit', (c, sig) => { serverLog += 'EXITED code=' + c + ' sig=' + sig; });

const stop = () => { try { server.kill(); } catch {} };

// Exiting while the spawned server is still being torn down trips a libuv
// assertion on Windows, which turned a passing run into a failing exit code.
// Setting exitCode and letting the loop drain avoids the race.
function finish(code) {
  stop();
  process.exitCode = code;
}

(async () => {
  // wait for it to listen
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) break; } catch {}
    await wait(100);
  }

  // --- admin session ---
  const login = await call('/api/admin-login', { method: 'POST', body: { username: 'admin', password: ADMIN_PASS } });
  check(login.status === 200, 'admin can log in', `status ${login.status}`);

  // --- 1. plans: one published, one still being written ---
  const save = await call('/admin/api/plans', {
    method: 'POST', admin: true,
    body: {
      plans: [
        { id: 'monthly', name: 'Monthly', price: 'LKR 990', period: 'per month', active: true,
          features: ['Unlimited downloads', '4K quality', 'Torrents'], order: 1 },
        { id: 'lifetime', name: 'Lifetime', price: 'LKR 9900', period: 'one time', active: true, highlight: true,
          features: ['Everything in Monthly', 'Pay once'], order: 2 },
        { id: 'draft', name: 'Draft plan', price: '', period: '', active: false, features: [], order: 3 },
      ],
    },
  });
  check(save.status === 200 && save.body?.plans?.length === 3, 'admin saves three plans', `status ${save.status}`);

  const badPlan = await call('/admin/api/plans', {
    method: 'POST', admin: true,
    body: { plans: [{ name: 'Bad', period: 'per fortnight' }] },
  });
  check(badPlan.status === 400, 'a plan with a nonsense billing period is refused', badPlan.body?.error || '');

  // --- 2. notices for different audiences ---
  const n1 = await call('/admin/api/notices', {
    method: 'POST', admin: true,
    body: { title: 'Welcome to Velox', body: 'Thanks for installing.', audience: 'all', level: 'info' },
  });
  check(n1.status === 200, 'admin can publish a notice to everyone');

  const n2 = await call('/admin/api/notices', {
    method: 'POST', admin: true,
    body: { title: 'Paid only', body: 'For subscribers.', audience: 'paid', level: 'info' },
  });
  check(n2.status === 200, 'admin can publish a notice aimed at paid users');

  const n3 = await call('/admin/api/notices', {
    method: 'POST', admin: true,
    body: { title: 'Your free downloads are gone', body: 'Upgrade for unlimited.', audience: 'trial-exhausted',
            level: 'promo', actionLabel: 'See plans', actionUrl: 'https://veloxdownloader.prolanka.online/#pricing' },
  });
  check(n3.status === 200, 'admin can publish an offer for people whose trial ran out');

  const badLink = await call('/admin/api/notices', {
    method: 'POST', admin: true,
    body: { title: 'Bad link', audience: 'all', actionUrl: 'javascript:alert(1)' },
  });
  check(badLink.status === 400, 'a notice button link that is not https is refused', badLink.body?.error || '');

  // --- 3. a customer signs up and activates ---
  const signup = await call('/api/signup', {
    method: 'POST', body: { email: 'buyer@example.com', deviceId: 'DEV-TEST-1', deviceName: 'Test PC' },
  });
  check(signup.status === 200 && signup.body?.key, 'a customer can sign up for a trial key');
  const key = signup.body?.key;

  const activate = await call('/api/activate', {
    method: 'POST', body: { key, deviceId: 'DEV-TEST-1', deviceName: 'Test PC' },
  });
  check(activate.status === 200 && activate.body?.token, 'the key activates');
  let token = activate.body?.token;

  // --- 4. what the app is handed ---
  const plansSeen = (activate.body?.plans || []).map((p) => p.id);
  check(plansSeen.join(',') === 'monthly,lifetime',
    'the app is sent only the published plans, in order', `got: ${plansSeen.join(',') || 'none'}`);
  check(!JSON.stringify(activate.body?.plans || []).includes('Draft'),
    'the unfinished draft plan never reaches the app');

  const titles = (activate.body?.notices || []).map((n) => n.title);
  check(titles.includes('Welcome to Velox'), 'the everyone notice reaches a trial user', titles.join(' | '));
  check(!titles.includes('Paid only'), 'the paid-only notice does not reach a trial user');
  check(!titles.includes('Your free downloads are gone'),
    'the trial-ran-out offer stays away while free downloads remain');

  check(activate.body?.profile?.plan?.name === 'Free trial', 'a trial key is named as the trial it is',
    JSON.stringify(activate.body?.profile?.plan || {}));
  check(activate.body?.profile?.downloadsToday === 0, "the customer starts the day on zero downloads");

  // --- 5. downloads are counted, and the trial wall is caught ---
  for (let i = 0; i < 3; i++) {
    const a = await call('/api/authorize', { method: 'POST', body: { token } });
    if (a.body?.token) token = a.body.token;
  }
  const beat = await call('/api/heartbeat', { method: 'POST', body: { token } });
  check(beat.status === 200, 'heartbeat still works after three downloads', `status ${beat.status}`);
  check(beat.body?.profile?.downloadsToday === 3, "today's downloads are counted",
    `got ${beat.body?.profile?.downloadsToday}`);
  check(beat.body?.profile?.trialRemaining === 0, 'the trial is now spent',
    `remaining ${beat.body?.profile?.trialRemaining}`);

  const nowTitles = (beat.body?.notices || []).map((n) => n.title);
  check(nowTitles.includes('Your free downloads are gone'),
    'the upgrade offer appears exactly when the free downloads run out', nowTitles.join(' | '));
  check(beat.body?.plans?.length === 2, 'the heartbeat carries the pricing table too');

  // --- 6. a change in the panel reaches the running app on the next beat ---
  await call('/admin/api/plans', {
    method: 'POST', admin: true,
    body: { plans: [{ id: 'monthly', name: 'Monthly', price: 'LKR 1290', period: 'per month', active: true, features: ['Unlimited downloads'], order: 1 }] },
  });
  const beat2 = await call('/api/heartbeat', { method: 'POST', body: { token } });
  check(beat2.body?.plans?.length === 1 && beat2.body.plans[0].price === 'LKR 1290',
    'a price edited in the panel is live on the next heartbeat, with no restart',
    JSON.stringify(beat2.body?.plans || []));

  // switching a notice off pulls it back
  const noticeId = n1.body?.notice?.id;
  await call(`/admin/api/notices/${noticeId}`, { method: 'PATCH', admin: true, body: { active: false } });
  const beat3 = await call('/api/heartbeat', { method: 'POST', body: { beat: 1, token: beat2.body?.token || token } });
  check(!(beat3.body?.notices || []).some((n) => n.id === noticeId),
    'switching a notice off in the panel withdraws it from the app');

  // --- 7. the panel keeps everything, including what it has not published ---
  const adminPlans = await call('/admin/api/plans', { admin: true });
  check(adminPlans.body?.plans?.length === 1, 'the panel shows the full plan list');
  const adminNotices = await call('/admin/api/notices', { admin: true });
  check((adminNotices.body?.notices || []).length === 3, 'the panel shows every notice, on or off',
    `${(adminNotices.body?.notices || []).length} notices`);

  // --- 8. none of this is reachable without an admin session ---
  const saved = cookie; cookie = '';
  const sneaky = await call('/admin/api/notices', { method: 'POST', body: { title: 'Hacked', audience: 'all' } });
  check(sneaky.status === 401 || sneaky.status === 403, 'a stranger cannot publish a notice', `status ${sneaky.status}`);
  cookie = saved;

  console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'}`);
  if (failures) console.log('\nserver log:\n' + serverLog.slice(-1500));
  finish(failures ? 1 : 0);
})().catch((err) => {
  console.error('TEST CRASHED:', err.message);
  console.log('server log:\n' + serverLog.slice(-2000));
  finish(2);
});
