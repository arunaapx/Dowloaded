// The Node server's own test suites, run against the Rust one.
//
//   node server-rs/test/parity.js
//
// This is the whole point of the port. The suites in server/test/ do not test
// one implementation against itself: they test the rules the business depends on
// — who may activate, how many machines a key covers, what a trial spends, which
// notice reaches whom — against whatever is serving them. The rewrite is
// finished when they pass unchanged.
//
// Each suite is written to start its own Node server with a particular
// environment (its own admin password, its own trial size, its own rate limits).
// Pointed at an external base it starts nothing, so this script starts the Rust
// binary with that suite's environment instead, in a throwaway data directory,
// and runs the suite against it.
//
// Build first: cargo build --manifest-path server-rs/Cargo.toml

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const BINARY = path.join(
  ROOT,
  'server-rs/target/debug',
  process.platform === 'win32' ? 'velox-license.exe' : 'velox-license',
);

// What each suite's own spawn block sets. Kept here rather than read out of the
// suite so that a suite changing its password is a visible failure here, not a
// silent one.
const SUITES = [
  {
    file: 'licensing.test.js',
    port: 4211,
    env: { ADMIN_USER: 'admin', ADMIN_PASS: 'test-pass-123', VELOX_TRIAL_DOWNLOADS: '3', NODE_ENV: 'test' },
  },
  {
    file: 'devices.test.js',
    port: 4212,
    // This suite activates dozens of machines in a few seconds, which the per-IP
    // limiter is right to refuse in production and wrong to refuse here.
    env: {
      ADMIN_USER: 'admin',
      ADMIN_PASS: 'dev-test-pass',
      VELOX_ACTIVATE_PER_MIN: '500',
      VELOX_HEARTBEAT_PER_MIN: '500',
    },
  },
];

async function waitFor(base) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  if (!fs.existsSync(BINARY)) {
    console.error(`No Rust server at ${BINARY}\nRun: cargo build --manifest-path server-rs/Cargo.toml`);
    process.exit(1);
  }

  let failed = 0;
  for (const suite of SUITES) {
    const base = `http://127.0.0.1:${suite.port}`;
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-parity-'));
    console.log('─'.repeat(68));
    console.log(`${suite.file}  →  rust on ${suite.port}`);
    console.log('─'.repeat(68));

    const server = spawn(BINARY, [], {
      cwd: path.join(ROOT, 'server-rs'),
      env: { ...process.env, ...suite.env, PORT: String(suite.port), DATA_DIR: data, RUST_LOG: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout.on('data', (d) => {
      log += d;
    });
    server.stderr.on('data', (d) => {
      log += d;
    });

    if (!(await waitFor(base))) {
      console.error(`the server never came up:\n${log}`);
      server.kill();
      failed += 1;
      continue;
    }

    const run = spawnSync(process.execPath, [path.join(ROOT, 'server/test', suite.file)], {
      stdio: 'inherit',
      env: { ...process.env, VELOX_TEST_BASE: base },
    });
    if (run.status !== 0) {
      failed += 1;
      if (log.trim()) console.log(`\nserver log:\n${log.split('\n').slice(-20).join('\n')}`);
    }
    server.kill();
    console.log('');
  }

  if (failed) {
    console.log(`${failed} of ${SUITES.length} suites FAILED against the Rust server`);
    process.exitCode = 1;
    return;
  }
  console.log(`all ${SUITES.length} suites passed against the Rust server`);
})();
