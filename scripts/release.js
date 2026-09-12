#!/usr/bin/env node
'use strict';

// One-command release for the desktop app.
//
//   npm run release            -> 2.1.1 becomes 2.1.2
//   npm run release -- minor   -> 2.1.1 becomes 2.2.0
//   npm run release -- 3.0.0   -> exactly that
//   npm run release -- --dry-run
//
// It bumps the version, builds the installer, checks the build is actually
// shippable, copies it to the update server, and reads the feed back over HTTPS
// to prove clients can see it. Nothing here needs editing between releases.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CONFIG_PATH = path.join(ROOT, 'release.config.json');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const DRY_RUN = has('--dry-run');
const SKIP_BUILD = has('--skip-build');
const SKIP_SITE = has('--no-site');
const bumpArg = args.find((a) => !a.startsWith('--')) || 'patch';

// ---------------------------------------------------------------------------

let step = 0;
const say = (msg) => console.log(msg);
const heading = (msg) => console.log('\n[' + ++step + '] ' + msg);
const ok = (msg) => console.log('    ok   ' + msg);
const info = (msg) => console.log('    ' + msg);

function die(msg, hint) {
  console.error('\nrelease failed: ' + msg);
  if (hint) console.error('\n' + hint);
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, shell: false, ...opts });
  if (r.error) die('could not run ' + cmd + ' (' + r.error.message + ')');
  if (r.status !== 0) die(cmd + ' exited with code ' + r.status);
  return r;
}

function capture(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', cwd: ROOT, shell: false, ...opts });
  if (r.error) die('could not run ' + cmd + ' (' + r.error.message + ')');
  return r;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function nextVersion(current, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [maj, min, pat] = current.split('.').map(Number);
  if (spec === 'major') return (maj + 1) + '.0.0';
  if (spec === 'minor') return maj + '.' + (min + 1) + '.0';
  if (spec === 'patch') return maj + '.' + min + '.' + (pat + 1);
  die('do not understand version "' + spec + '"', 'Use: patch, minor, major, or an exact version like 2.3.0.');
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const template = {
      sshTarget: 'root@veloxdownloader.prolanka.online',
      remoteUpdatesDir: '/opt/velox/updates',
      remoteDownloadsDir: '/opt/velox/downloads',
      publicInstallerName: 'VeloxDownloader.exe',
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2) + '\n');
    die(
      'no release.config.json yet, so I wrote one for you',
      'Open release.config.json, check sshTarget points at your server, then run\n' +
      'this again. The file is gitignored, so your server details stay local.\n\n' +
      'You also need key-based SSH working. Test it with:\n' +
      '  ssh ' + template.sshTarget + ' echo ok'
    );
  }
  const cfg = readJson(CONFIG_PATH);
  if (!cfg.sshTarget) die('release.config.json has no sshTarget');
  return {
    remoteUpdatesDir: '/opt/velox/updates',
    remoteDownloadsDir: '/opt/velox/downloads',
    publicInstallerName: 'VeloxDownloader.exe',
    ...cfg,
  };
}

function updateFeedUrl(pkg) {
  const publish = [].concat(pkg.build && pkg.build.publish || []);
  const generic = publish.find((p) => p && p.provider === 'generic' && p.url);
  if (!generic) die('package.json has no generic publish url to release to');
  return generic.url.replace(/\/+$/, '');
}

// The bug that shipped in 2.1.0: cloudscraper requires request-promise-core
// without declaring it, and electron-builder nests the copy where cloudscraper
// cannot see it. The app then dies on launch. Never ship that twice.
function verifyPackagedApp() {
  const asarPath = path.join(DIST, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) die('no app.asar at ' + asarPath);

  let asar;
  try {
    asar = require('@electron/asar');
  } catch (e) {
    info('warn: @electron/asar not available, skipping asar checks');
    return;
  }

  const files = asar.listPackage(asarPath).map((f) => f.split(path.sep).join('/'));
  const required = [
    '/node_modules/request-promise-core/errors.js',
    '/node_modules/electron-updater/package.json',
    '/main.js',
    '/renderer/app.js',
  ];
  const missing = required.filter((f) => !files.includes(f));
  if (missing.length) {
    die(
      'the packaged app is missing ' + missing.join(', '),
      'This is the class of bug that made 2.1.0 crash on launch. Check the\n' +
      '"files" block in package.json before shipping.'
    );
  }
  ok('packaged app has everything it needs to boot');
}

// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const feedUrl = updateFeedUrl(pkg);
  const from = pkg.version;
  const to = nextVersion(from, bumpArg);

  say('Velox release');
  say('  version  ' + from + '  ->  ' + to);
  say('  server   ' + cfg.sshTarget + ':' + cfg.remoteUpdatesDir);
  say('  feed     ' + feedUrl + '/latest.yml');
  if (DRY_RUN) say('  DRY RUN - nothing will be built, uploaded, or changed');

  const setupName = 'VeloxDownloader-Setup-' + to + '.exe';
  const blockmapName = setupName + '.blockmap';
  const portableName = 'VeloxDownloader-Portable-' + to + '.exe';

  // 1 -----------------------------------------------------------------------
  heading('Check the server is reachable');
  if (DRY_RUN) {
    info('skipped (dry run)');
  } else {
    const probe = capture('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', cfg.sshTarget, 'echo ok']);
    if (probe.status !== 0 || !String(probe.stdout).includes('ok')) {
      die(
        'cannot reach ' + cfg.sshTarget + ' over SSH',
        'Key-based login has to work without a password prompt. Test it with:\n' +
        '  ssh ' + cfg.sshTarget + ' echo ok\n\n' +
        'If that asks for a password, set up a key first:\n' +
        '  ssh-keygen -t ed25519\n' +
        '  ssh-copy-id ' + cfg.sshTarget
      );
    }
    ok('SSH works');
  }

  // 2 -----------------------------------------------------------------------
  heading('Set the version to ' + to);
  if (DRY_RUN) {
    info('skipped (dry run)');
  } else {
    run('npm', ['version', to, '--no-git-tag-version', '--allow-same-version'], { stdio: 'ignore', shell: process.platform === 'win32' });
    ok('package.json is now ' + to);
  }

  // 3 -----------------------------------------------------------------------
  heading('Build the installer');
  if (DRY_RUN || SKIP_BUILD) {
    info(SKIP_BUILD ? 'skipped (--skip-build)' : 'skipped (dry run)');
  } else {
    fs.rmSync(path.join(DIST, 'win-unpacked'), { recursive: true, force: true });
    info('this takes a few minutes...');
    run('npm', ['run', 'build'], { shell: process.platform === 'win32' });
    ok('built');
  }

  // 4 -----------------------------------------------------------------------
  heading('Check the build before anyone gets it');
  if (DRY_RUN) {
    info('skipped (dry run)');
  } else {
    for (const f of [setupName, blockmapName, 'latest.yml']) {
      if (!fs.existsSync(path.join(DIST, f))) die('dist/' + f + ' was not produced by the build');
    }
    ok('installer, blockmap and latest.yml are present');

    const feed = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
    const m = feed.match(/^version:\s*(.+)$/m);
    if (!m || m[1].trim() !== to) {
      die('dist/latest.yml says version ' + (m ? m[1].trim() : '?') + ', expected ' + to);
    }
    ok('latest.yml advertises ' + to);

    verifyPackagedApp();
  }

  // 5 -----------------------------------------------------------------------
  // Order matters. The installer goes up first and latest.yml last, so a client
  // that checks mid-upload never sees a release pointing at a half-written file.
  heading('Upload to the update server');
  if (DRY_RUN) {
    info('would upload ' + setupName + ', ' + blockmapName + ', then latest.yml');
  } else {
    run('ssh', [cfg.sshTarget, 'mkdir -p ' + cfg.remoteUpdatesDir]);
    info('uploading ' + setupName + ' (~' + Math.round(fs.statSync(path.join(DIST, setupName)).size / 1048576) + ' MB)...');
    // scp runs from dist/ so Windows drive letters never reach its host:path parser.
    run('scp', [setupName, blockmapName, cfg.sshTarget + ':' + cfg.remoteUpdatesDir + '/'], { cwd: DIST });
    ok('installer and blockmap uploaded');
    run('scp', ['latest.yml', cfg.sshTarget + ':' + cfg.remoteUpdatesDir + '/'], { cwd: DIST });
    ok('latest.yml uploaded - the release is now live');
  }

  // 6 -----------------------------------------------------------------------
  heading('Refresh the download on the website');
  if (SKIP_SITE) {
    info('skipped (--no-site)');
  } else if (DRY_RUN) {
    info('would copy the installer to ' + cfg.remoteDownloadsDir + '/' + cfg.publicInstallerName);
  } else {
    const remoteSetup = cfg.remoteUpdatesDir + '/' + setupName;
    const publicPath = cfg.remoteDownloadsDir + '/' + cfg.publicInstallerName;
    run('ssh', [cfg.sshTarget, 'mkdir -p ' + cfg.remoteDownloadsDir + ' && cp ' + remoteSetup + ' ' + publicPath]);
    ok('new buyers now get ' + to + ' from the site');
  }

  // 7 -----------------------------------------------------------------------
  heading('Read the feed back the way a client would');
  if (DRY_RUN) {
    info('skipped (dry run)');
  } else {
    try {
      const body = await fetchText(feedUrl + '/latest.yml');
      const m = body.match(/^version:\s*(.+)$/m);
      const served = m ? m[1].trim() : '(no version line)';
      if (served !== to) {
        die(
          'the server is serving version ' + served + ', not ' + to,
          'The files uploaded but nginx is not serving them. Check that the\n' +
          '/updates/ location exists and points at ' + cfg.remoteUpdatesDir + ':\n' +
          '  sudo nginx -t && sudo systemctl reload nginx'
        );
      }
      ok('clients can see ' + to);
    } catch (e) {
      die(
        'could not read ' + feedUrl + '/latest.yml (' + e.message + ')',
        'The upload finished, but the feed is not reachable. Almost always the\n' +
        'nginx /updates/ block is missing - see deploy/DEPLOY.md section 8.'
      );
    }
  }

  // -------------------------------------------------------------------------
  if (DRY_RUN) {
    say('\nDry run finished. Nothing was built, uploaded, or changed.');
    say('Run it again without --dry-run to ship ' + to + '.');
    return;
  }

  say('\nDone. ' + to + ' is live.');
  say('');
  say('  Running apps pick it up within 6 hours, or on their next launch.');
  say('  Local files: dist/' + setupName);
  say('               dist/' + portableName);
  say('');
  say('  Keep the previous release on the server - clients use its blockmap to');
  say('  download only what changed instead of the whole installer.');
}

main().catch((e) => die(e && e.message || String(e)));
