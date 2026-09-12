// Does every piece the app reaches for actually exist?
//
// This exists because of a bug that shipped: main.js imported `playlistEntries`
// from core/extractor.js, the renderer had a whole playlist picker built on it,
// and the function was never in the module. Destructuring a missing export is
// silent — you get `undefined` — so the app started, the picker opened, and the
// only sign of trouble was "This playlist could not be read. Check your
// connection and try again." on every playlist anyone clicked.
//
// Nothing else would have caught it. The unit tests never load main.js, the
// build only checks that files are present, and the failure looked exactly like
// a network problem. So this reads the imports out of the source and checks each
// one against what the module really exports.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  [' + extra + ']' : ''}`);
  if (!ok) failures++;
};

/// Every `const { a, b: c } = require('./x')` in a file, as {module, names}.
function destructuredRequires(source) {
  const out = [];
  const re = /const\s*\{([^}]+)\}\s*=\s*require\(\s*'([^']+)'\s*\)/g;
  let m;
  while ((m = re.exec(source))) {
    const names = m[1]
      .split(',')
      .map((part) => part.split(':')[0].trim())      // `search: ytSearch` imports `search`
      .filter((n) => n && /^[A-Za-z_$][\w$]*$/.test(n));
    out.push({ module: m[2], names });
  }
  return out;
}

// The files that wire the app together, and are never loaded by any other test.
const WIRING = ['main.js', 'preload.js'];

for (const file of WIRING) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) {
    check(false, `${file} exists`);
    continue;
  }
  const source = fs.readFileSync(full, 'utf8');

  for (const { module: spec, names } of destructuredRequires(source)) {
    // Only our own modules. A missing export from a dependency is npm's problem
    // and shows up at install time.
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
    // Electron itself is not loadable outside Electron.
    if (spec === 'electron') continue;

    let mod;
    try {
      mod = require(path.resolve(path.dirname(full), spec));
    } catch (e) {
      check(false, `${file} can load ${spec}`, e.message.split('\n')[0]);
      continue;
    }

    const missing = names.filter((n) => mod[n] === undefined);
    check(
      missing.length === 0,
      `${file} imports only things ${spec} exports`,
      missing.length ? 'missing: ' + missing.join(', ') : names.length + ' names'
    );
  }
}

// The playlist picker in particular, because that is the one that shipped
// broken: the renderer, the preload bridge, the main-process handler and the
// function itself are four separate files, and three of them were right.
const extractor = require(path.join(ROOT, 'core', 'extractor'));
check(typeof extractor.playlistEntries === 'function',
  'core/extractor exports playlistEntries — the picker calls it on every playlist');
check(/ipcMain\.handle\('playlist-info'/.test(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')),
  'main.js answers the playlist-info channel');
check(/playlistInfo:/.test(fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')),
  'preload offers playlistInfo to the renderer');
check(/window\.api\?\.playlistInfo|window\.api\.playlistInfo/.test(
  fs.readFileSync(path.join(ROOT, 'renderer', 'playlist.js'), 'utf8')),
  'and the picker calls it');

// Every channel the preload bridge exposes has somebody listening for it.
// The same class of bug, one layer out: invoking a channel nobody handles
// rejects, and the renderer usually reports that as a network failure.
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
const handled = new Set([...mainSource.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]));
const orphans = [...new Set(invoked)].filter((c) => !handled.has(c));
check(
  orphans.length === 0,
  'every channel preload can invoke is handled in main',
  orphans.length ? 'nobody handles: ' + orphans.join(', ') : invoked.length + ' channels'
);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exitCode = failures ? 1 : 0;
