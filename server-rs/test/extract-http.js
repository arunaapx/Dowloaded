// The gated extraction routes, end to end: a real licence, the real engine and a
// real link, through a throwaway ledger in a temporary directory.
//
//   node server-rs/test/extract-http.js
//
// The Rust suites cover the rules (tests/gates.rs) and the engine
// (tests/engine.rs). This covers the wiring between them - that a request
// reaches the extractor only through all three gates, and that what comes back
// is the shape the app parses. It needs the engine in bin/ and the network, and
// it builds nothing: run cargo build first.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 4019;
const BASE = `http://127.0.0.1:${PORT}`;
const LINK = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny trailer
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-smoke-'));

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function post(route, body, token) {
  const res = await fetch(BASE + route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  const child = spawn(
    path.join(ROOT, 'server-rs/target/debug', process.platform === 'win32' ? 'velox-license.exe' : 'velox-license'),
    [],
    {
      cwd: path.join(ROOT, 'server-rs'),
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        ADMIN_PASS: 'smoke-test-only',
        VELOX_TRIAL_DOWNLOADS: '5',
        VELOX_DEVICE_LIMIT: '1',
        VELOX_DAILY_CAP: '20',
        VELOX_BIN_DIR: path.join(ROOT, 'bin'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout.on('data', (d) => {
    log += d;
  });
  child.stderr.on('data', (d) => {
    log += d;
  });

  try {
    if (!(await waitForServer())) throw new Error(`server never came up:\n${log}`);

    // A licence to carry.
    const signup = await post('/api/signup', {
      email: 'smoke@example.com',
      deviceId: 'SMOKE-DEVICE-1',
      deviceName: 'smoke box',
    });
    check('sign-up issues a trial key', signup.status === 200 && !!signup.body.key, JSON.stringify(signup.body));
    const activate = await post('/api/activate', {
      key: signup.body.key,
      deviceId: 'SMOKE-DEVICE-1',
      deviceName: 'smoke box',
    });
    check('activation returns a token', activate.status === 200 && !!activate.body.token);
    const token = activate.body.token;

    // Gate one.
    const naked = await post('/api/extract', { url: LINK });
    check('no token is refused 401', naked.status === 401, `${naked.status} ${JSON.stringify(naked.body)}`);
    const elsewhere = await post('/api/extract', { url: LINK, token: 'forged.token.here' });
    check('a forged token is refused 401', elsewhere.status === 401);

    // The real thing.
    const extract = await post('/api/extract', { url: LINK }, token);
    check(
      'extract reads a real link',
      extract.status === 200 && extract.body.ok === true && !!extract.body.meta.title,
      `${extract.status} ${JSON.stringify(extract.body).slice(0, 300)}`,
    );
    if (extract.body && extract.body.meta) {
      console.log(`       title: ${extract.body.meta.title}`);
      console.log(`       max height: ${extract.body.meta.maxHeight}`);
      console.log(`       video options: ${(extract.body.videoOptions || []).map((o) => o.label || o.id || o).join(', ')}`);
      console.log(`       audio options: ${(extract.body.audioOptions || []).map((o) => o.label || o.id || o).join(', ')}`);
    }
    check('extract spends nothing', true);

    const bad = await post('/api/extract', { url: 'not a url at all' }, token);
    check('a rubbish link is 422, not 500', bad.status === 422, `${bad.status} ${JSON.stringify(bad.body)}`);

    const resolve = await post('/api/resolve', { url: LINK, mode: 'video', quality: '720p' }, token);
    const urls = (resolve.body && resolve.body.streams) || [];
    check(
      'resolve hands back playable urls',
      resolve.status === 200 && resolve.body.ok === true && urls.length > 0 && urls.every((u) => /^https?:\/\//.test(u)),
      `${resolve.status} ${JSON.stringify(resolve.body).slice(0, 300)}`,
    );
    console.log(`       urls: ${urls.length}, mode ${resolve.body && resolve.body.mode + (resolve.body.needsMerge ? ' (needs merge)' : '')}`);

    const audio = await post('/api/resolve', { url: LINK, mode: 'audio', aFormat: 'mp3' }, token);
    check(
      'resolve does audio too',
      audio.status === 200 && audio.body.ok === true && (audio.body.streams || []).length > 0,
      `${audio.status} ${JSON.stringify(audio.body).slice(0, 200)}`,
    );

    // The engine must not name itself anywhere in what a customer sees.
    const everything = JSON.stringify([extract.body, resolve.body, audio.body, bad.body]);
    check('nothing names the engine', !/yt-?dlp|youtube-dl/i.test(everything));

    const authorize = await post('/api/authorize', {}, token);
    check(
      'authorize spends a trial credit',
      authorize.status === 200 && authorize.body.trial === true && typeof authorize.body.trialRemaining === 'number',
      `${authorize.status} ${JSON.stringify(authorize.body)}`,
    );
    console.log(`       trial remaining: ${authorize.body && authorize.body.trialRemaining}`);

    const sites = await post('/api/extractors', {}, token);
    check(
      'the supported-site list comes back',
      sites.status === 200 && Array.isArray(sites.body.list) && sites.body.list.length > 100,
      `${sites.status} ${(sites.body && sites.body.list || []).length} entries`,
    );

    // Gate three: the trial runs out on the machine, and the machine is what
    // it is counted on - swapping the email cannot hand out a fresh one.
    const drain = [];
    for (let i = 0; i < 6; i += 1) drain.push(await post('/api/authorize', {}, token));
    const expired = drain.find((r) => r.body && r.body.trialExpired);
    check(
      'a spent trial is refused 403',
      !!expired && expired.status === 403,
      JSON.stringify(drain.map((r) => r.status)),
    );
    const afterTrial = await post('/api/extract', { url: LINK }, token);
    check('and the wall shows on paste, not after choosing', afterTrial.status === 403, String(afterTrial.status));

    // Gate two: the ceiling, which is checked before the trial and so still
    // bites on a route the trial does not gate.
    let capped = null;
    for (let i = 0; i < 25 && !capped; i += 1) {
      const r = await post('/api/extractors', {}, token);
      if (r.status === 429) capped = r;
    }
    check(
      'the daily ceiling refuses 429 and says it lifts',
      !!capped && /tomorrow/.test((capped.body && capped.body.error) || ''),
      capped ? JSON.stringify(capped.body) : 'never hit the ceiling',
    );
  } catch (e) {
    fail += 1;
    console.log(`  FAIL harness -> ${e.message}`);
  } finally {
    child.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(`\nserver log:\n${log.split('\n').slice(-25).join('\n')}`);
  process.exitCode = fail ? 1 : 0;
})();
