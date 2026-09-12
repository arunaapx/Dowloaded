// The licence on disk: not findable by name, not readable, not editable, and
// not usable on another machine.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJ = path.join(__dirname, '..');
const store = require(path.join(PROJ, 'core', 'license-store.js'));

const DIR = path.join(os.tmpdir(), 'velox-store-test-' + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let failures = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  [' + extra + ']' : ''}`);
  if (!ok) failures++;
};

const HW_A = 'aaaa1111bbbb2222cccc3333dddd4444';
const HW_B = 'ffff9999eeee8888dddd7777cccc6666';
const LICENCE = { key: 'VLX-ABCDE-FGHIJ-KLMNO', token: 'jwt.token.here', email: 'buyer@example.com', deviceId: HW_A };

// --- 1. nothing on disk says "licence" --------------------------------------
store.write(DIR, HW_A, LICENCE);
const files = fs.readdirSync(DIR);
check(files.length === 1, 'exactly one file is written', files.join(', '));
check(!/licen[cs]e|key|velox/i.test(files[0]), 'its name gives nothing away', files[0]);
check(/^[0-9a-f]{24}\.dat$/.test(files[0]), 'it is a plain hex name with a dull extension', files[0]);
check(store.storeName(HW_A) !== store.storeName(HW_B),
  'two machines never use the same file name, so "delete X" instructions do not travel');

// --- 2. the contents are not readable ---------------------------------------
const raw = fs.readFileSync(path.join(DIR, files[0]));
const asText = raw.toString('latin1');
check(!asText.includes('VLX-ABCDE'), 'the licence key is not in the file');
check(!asText.includes('buyer@example.com'), 'nor is the email');
check(!asText.includes('jwt.token.here'), 'nor is the token');
check(raw.subarray(0, 4).toString() === 'VLX1', 'it does carry a marker, so a stray file is recognised not parsed');

// --- 3. the app can still read its own licence ------------------------------
const back = store.read(DIR, HW_A);
check(back && back.key === LICENCE.key && back.email === LICENCE.email,
  'the app reads back exactly what it wrote');

// --- 4. copied to another machine it is worthless ---------------------------
const OTHER = path.join(DIR, 'other-machine');
fs.mkdirSync(OTHER, { recursive: true });
fs.copyFileSync(path.join(DIR, files[0]), path.join(OTHER, files[0]));
check(store.read(OTHER, HW_B) === null,
  'copied to a second PC it reads as no licence at all — the name and the key both belong to the first machine');
check(store.read(OTHER, HW_A) !== null,
  '(the same file on the machine it came from still works, so this is the machine check and not a broken file)');

// --- 5. editing the bytes invalidates it ------------------------------------
const TAMPER = path.join(DIR, 'tampered');
fs.mkdirSync(TAMPER, { recursive: true });
const bytes = Buffer.from(raw);
bytes[bytes.length - 5] ^= 0xff;                       // flip a bit in the ciphertext
fs.writeFileSync(path.join(TAMPER, files[0]), bytes);
check(store.read(TAMPER, HW_A) === null, 'a single edited byte makes the whole file invalid');

// --- 6. an old install is carried across without re-activating --------------
const LEGACY = path.join(DIR, 'legacy');
fs.mkdirSync(LEGACY, { recursive: true });
fs.writeFileSync(path.join(LEGACY, 'license.json'), JSON.stringify(LICENCE, null, 2));
const migrated = store.read(LEGACY, HW_A);
check(migrated && migrated.key === LICENCE.key, 'an existing license.json is picked up, so nobody re-activates');
check(!fs.existsSync(path.join(LEGACY, 'license.json')), 'and the plain file is removed afterwards');
check(fs.existsSync(store.storePath(LEGACY, HW_A)), 'replaced by the encrypted one');

// --- 7. clearing removes both forms -----------------------------------------
fs.writeFileSync(path.join(LEGACY, 'license.json'), '{}');   // a leftover from an old build
store.clear(LEGACY, HW_A);
check(!fs.existsSync(store.storePath(LEGACY, HW_A)) && !fs.existsSync(path.join(LEGACY, 'license.json')),
  'signing out removes every copy, old and new');

// --- 8. a machine with no hardware id still works ---------------------------
const NOHW = path.join(DIR, 'nohw');
fs.mkdirSync(NOHW, { recursive: true });
store.write(NOHW, '', LICENCE);
const noHwBack = store.read(NOHW, '');
check(noHwBack && noHwBack.key === LICENCE.key, 'a machine that will not identify itself is not locked out');
const noHwRaw = fs.readFileSync(store.storePath(NOHW, '')).toString('latin1');
check(!noHwRaw.includes('VLX-ABCDE'), 'and its file is still encrypted at rest');

// --- 9. a half-written file never destroys a good one -----------------------
const ATOMIC = path.join(DIR, 'atomic');
fs.mkdirSync(ATOMIC, { recursive: true });
store.write(ATOMIC, HW_A, LICENCE);
store.write(ATOMIC, HW_A, { ...LICENCE, key: 'VLX-SECOND' });
check(fs.readdirSync(ATOMIC).length === 1, 'a rewrite leaves no temporary file behind',
  fs.readdirSync(ATOMIC).join(', '));
check(store.read(ATOMIC, HW_A).key === 'VLX-SECOND', 'and the newest licence is what is read');

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);
