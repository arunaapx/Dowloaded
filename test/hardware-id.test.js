// Run with: npm test
//
// The machine identity: it has to be the same PC every time, a different one
// on different hardware, and nothing at all when the hardware only offers a
// placeholder that thousands of machines share.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJ = path.join(__dirname, '..');
const hw = require(path.join(PROJ, 'core', 'hardware-id.js'));

let failures = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  [' + extra + ']' : ''}`);
  if (!ok) failures++;
};

// --- 1. this machine ---------------------------------------------------------
const parts = hw.components();
const id = hw.hardwareId();
check(/^[0-9a-f]{32}$/.test(id), 'this machine produces a 32-character id', id);
check(hw.hardwareId() === id, 'asking twice gives the same answer');
check(hw.hardwareSource() === 'board', 'and it came from the board, not the OS install', hw.hardwareSource());

// A second process: no shared memory, no cached file — the machine alone.
const other = execFileSync(process.execPath, ['-e',
  `process.stdout.write(require(${JSON.stringify(path.join(PROJ, 'core', 'hardware-id.js'))}).hardwareId())`,
], { encoding: 'utf8' }).trim();
check(other === id, 'a separate process on the same PC gets the same id', other.slice(0, 12) + '…');

// --- 2. it is not the raw serials --------------------------------------------
const raw = [parts.uuid, parts.board, parts.guid].filter(Boolean).join('|');
check(raw.length > 0, 'the machine did answer with something', Object.keys(parts).filter((k) => parts[k]).join(', '));
check(!raw.toLowerCase().split('|').some((v) => id.includes(v.toLowerCase().slice(0, 8))),
  'the id is a hash — no serial number is sent to the server');

// --- 3. different hardware, different id -------------------------------------
const a = hw.hardwareId({ uuid: '35384831-3431-4834-5230-10B6761F7B14', board: 'PUSLC0287KS5CG', guid: 'g1' });
const b = hw.hardwareId({ uuid: '35384831-3431-4834-5230-10B6761F7B15', board: 'PUSLC0287KS5CG', guid: 'g1' });
const c = hw.hardwareId({ uuid: '35384831-3431-4834-5230-10B6761F7B14', board: 'DIFFERENTBOARD', guid: 'g1' });
check(a !== b && a !== c && b !== c, 'two different machines never share an id');
check(a === hw.hardwareId({ uuid: '35384831-3431-4834-5230-10b6761f7b14', board: 'puslc0287ks5cg', guid: 'g1' }),
  'upper and lower case are the same machine');

// --- 4. a Windows reinstall must not cost a customer their licence -----------
const before = hw.hardwareId({ uuid: 'U-1', board: 'B-1', guid: 'guid-before-reinstall' });
const after = hw.hardwareId({ uuid: 'U-1', board: 'B-1', guid: 'guid-after-reinstall' });
check(before === after, 'reinstalling Windows leaves the machine the same machine');

// --- 5. OEM placeholders are refused -----------------------------------------
for (const junk of ['Default string', 'To be filled by O.E.M.', '00000000-0000-0000-0000-000000000000',
  'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', '03000200-0400-0500-0006-000700080009', 'None', '   ', 'Not Applicable']) {
  if (hw.usable(junk) !== '') { check(false, `placeholder accepted: ${junk}`); }
}
check(true, 'the known OEM and hypervisor placeholders are all refused');

const shared = hw.hardwareId({ uuid: '03000200-0400-0500-0006-000700080009', board: 'Default string', guid: '' });
check(shared === '', 'a machine that only offers placeholders gets no id at all, so the app falls back');

// Two different PCs that both ship with the same placeholder must not collide.
const vm1 = hw.hardwareId({ uuid: '03000200-0400-0500-0006-000700080009', board: 'To be filled by O.E.M.', guid: 'machine-a' });
const vm2 = hw.hardwareId({ uuid: '03000200-0400-0500-0006-000700080009', board: 'To be filled by O.E.M.', guid: 'machine-b' });
check(vm1 !== vm2 && vm1 && vm2,
  'two OEM clones fall back to their own OS install id rather than sharing one licence');

// --- 6. the board outranks the OS install ------------------------------------
const boardWins = hw.hardwareId({ uuid: 'U-9', board: 'B-9', guid: 'G-9' });
const guidOnly = hw.hardwareId({ uuid: '', board: '', guid: 'G-9' });
check(boardWins !== guidOnly, 'the board is used when it is there, not the OS install id');
check(hw.hardwareSource({ uuid: '', board: '', guid: 'G-9' }) === 'os-install',
  'and a board-less machine says so');
check(hw.hardwareSource({ uuid: '', board: '', guid: '' }) === 'none', 'as does a machine that says nothing');

// --- 7. a disk swap must not lock anyone out ---------------------------------
// (there is no disk component at all — this is the assertion that keeps it that way)
const src = require('fs').readFileSync(path.join(PROJ, 'core', 'hardware-id.js'), 'utf8');
check(!/Win32_DiskDrive|SerialNumber.*DiskDrive/.test(src),
  'no disk serial is part of the identity, so replacing a disk keeps the licence');
check(!/Win32_NetworkAdapter|getMac|mac\b.*address/i.test(src.replace(/^\s*\/\/.*$/gm, '')),
  'and no MAC address, which docks and VPNs change constantly');


// --- 8. uninstalling the app must not change the machine --------------------
//
// A reinstall wipes AppData. If the identity lived anywhere in there, a
// customer reinstalling would look like a brand new PC — and a trial could be
// farmed by uninstalling. So the same code runs again with every per-user
// folder pointed somewhere empty, and has to answer identically.
const wiped = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-wiped-'));
const afterReinstall = execFileSync(process.execPath, ['-e',
  'process.stdout.write(require(' + JSON.stringify(path.join(PROJ, 'core', 'hardware-id.js')) + ').hardwareId())',
], {
  encoding: 'utf8',
  env: { ...process.env, APPDATA: wiped, LOCALAPPDATA: wiped, USERPROFILE: wiped, HOME: wiped },
}).trim();
check(afterReinstall === id,
  'uninstalling and reinstalling leaves the machine the same machine',
  afterReinstall.slice(0, 12) + '…');
fs.rmSync(wiped, { recursive: true, force: true });

// It must not be reading a file at all — no cache to delete, none to edit.
check(!/writeFileSync|appendFileSync|mkdirSync/.test(src),
  'and it keeps no file of its own that anyone could delete or edit');

console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);
