// Build velox_engine and drop it where the app and the installer look for it.
//
// cargo writes to engine/target/release/, which is a developer path: it is
// gitignored, it is not in the packaged app, and electron-builder will not
// reach into it. bin/ is where every other binary this app ships already lives,
// so the DLL goes there too and the packaging config needs to know one path.
//
//   node scripts/build-engine.js            release build, copy into bin/
//   node scripts/build-engine.js --debug    debug build instead
//   node scripts/build-engine.js --skip-build  copy an existing build

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CRATE = path.join(ROOT, 'engine');

function dllName() {
  if (process.platform === 'win32') return 'velox_engine.dll';
  if (process.platform === 'darwin') return 'libvelox_engine.dylib';
  return 'libvelox_engine.so';
}

// cargo is run from inside the crate rather than with --manifest-path, and
// without a shell. Both matter on this project: the repo path contains a space,
// and a shell would split it apart before cargo ever saw it.
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

function main() {
  const debug = process.argv.includes('--debug');
  const skipBuild = process.argv.includes('--skip-build');
  const profile = debug ? 'debug' : 'release';

  if (!skipBuild) {
    const args = ['build'];
    if (!debug) args.push('--release');
    console.log(`cargo ${args.join(' ')}  (in ${path.relative(ROOT, CRATE)})`);
    run('cargo', args, CRATE);
  }

  const built = path.join(ROOT, 'engine', 'target', profile, dllName());
  if (!fs.existsSync(built)) {
    throw new Error(`no engine at ${built} — build it first`);
  }

  const dest = path.join(ROOT, 'bin', dllName());
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Copying onto a DLL some other process has mapped fails with EBUSY/EPERM on
  // Windows, and the usual culprit is an Electron or node run still holding the
  // previous build. Say which, rather than leaving a bare errno.
  try {
    fs.copyFileSync(built, dest);
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM') {
      throw new Error(
        `cannot replace ${dest} — something still has it loaded.\n` +
        'Close any running Velox or node process that used the engine, then try again.'
      );
    }
    throw e;
  }

  const mb = (fs.statSync(dest).size / 1048576).toFixed(2);
  console.log(`engine → ${path.relative(ROOT, dest)} (${mb} MB, ${profile})`);
}

try {
  main();
} catch (e) {
  console.error(`\nbuild-engine failed: ${e.message}`);
  process.exit(1);
}
