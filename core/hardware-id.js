// Which machine this is, asked of the machine rather than of a file we wrote.
//
// The old identity was a random salt saved in userData. Deleting that folder —
// or reinstalling the app — made the same PC look like a brand new one, which
// is how a free trial gets farmed: clear the folder, use another email, start
// again. The identity here comes from SMBIOS, so it survives reinstalling the
// app, reinstalling Windows, and clearing every file this app has ever
// written.
//
// What is deliberately NOT used:
//
//   * disk serials — people add and replace disks, and a paying customer who
//     upgrades one must not be locked out of what they bought;
//   * ProcessorId — it is CPUID feature bits plus the model, identical on every
//     machine with the same chip, so it identifies nothing;
//   * the MAC address — docks, VPNs and USB adapters change it constantly.
//
// The board is the machine. Replacing a motherboard reads as a new machine,
// which is the same line every licence of this kind draws, and an admin can
// move the licence across in the panel.
//
// Nothing raw ever leaves the PC: the values are hashed with a fixed pepper, so
// the server stores an opaque id and never learns a customer's serial numbers.

const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

// Vendors and hypervisors stamp these into SMBIOS when they cannot be bothered
// to write a real value. Accepting one would put every machine that ships with
// it on a single shared identity — a licence that unlocks for thousands of
// strangers, or a trial that is already spent when a customer first opens the
// app.
const PLACEHOLDERS = new Set([
  '', '0', 'none', 'null', 'default string', 'to be filled by o.e.m.',
  'to be filled by o.e.m. ', 'not applicable', 'not specified', 'unknown',
  'system serial number', 'chassis serial number', 'base board serial number',
  'invalid', 'x', 'xxxxxxx', 'oem', 'o.e.m.',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '03000200-0400-0500-0006-000700080009', // seen on VMware and on cheap OEM batches
]);

function usable(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || PLACEHOLDERS.has(s.toLowerCase())) return '';
  // A value made of one repeated character (000…, FFF…, ###…) is a filler too.
  if (/^(.)\1+$/.test(s.replace(/[\s-]/g, ''))) return '';
  return s;
}

function run(command, args, timeoutMs = 6000) {
  try {
    const r = spawnSync(command, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' });
    if (r.error || r.status !== 0) return '';
    return String(r.stdout || '');
  } catch {
    return '';
  }
}

// One PowerShell start-up is expensive, so everything is asked in a single
// call and the answers come back one per line, in a fixed order.
function windowsComponents() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '(Get-CimInstance Win32_ComputerSystemProduct).UUID',
    '(Get-CimInstance Win32_BaseBoard | Select-Object -First 1).SerialNumber',
    "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid",
  ].join('; ');
  const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const [uuid = '', board = '', guid = ''] = out.split(/\r?\n/).map((l) => l.trim());
  return { uuid: usable(uuid), board: usable(board), guid: usable(guid) };
}

function macComponents() {
  const out = run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return { uuid: usable(m && m[1]), board: '', guid: '' };
}

function linuxComponents() {
  const fs = require('fs');
  const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
  return {
    uuid: usable(read('/sys/class/dmi/id/product_uuid')),
    board: usable(read('/sys/class/dmi/id/board_serial')),
    guid: usable(read('/etc/machine-id')),
  };
}

function components() {
  if (process.platform === 'win32') return windowsComponents();
  if (process.platform === 'darwin') return macComponents();
  return linuxComponents();
}

// The board's own identity first — it survives a Windows reinstall, which is
// the case where a customer would otherwise lose the licence they paid for.
// MachineGuid is the last resort precisely because it does not: it is rewritten
// by a reinstall, so a machine that only has that will look new afterwards.
// Every value is filtered here rather than only where it was read, so a caller
// that hands over raw values cannot slip a placeholder through and put a
// thousand machines on one identity.
function identityParts(parts) {
  const board = [usable(parts && parts.uuid), usable(parts && parts.board)].filter(Boolean);
  if (board.length) return board;
  const guid = usable(parts && parts.guid);
  return guid ? [guid] : [];
}

const PEPPER = 'velox-hardware-v1';

// Returns 32 hex characters, or '' when the machine will not say anything
// usable about itself — the caller then falls back to the old behaviour rather
// than refusing to run.
function hardwareId(parts = components()) {
  const chosen = identityParts(parts);
  if (!chosen.length) return '';
  return crypto
    .createHash('sha256')
    .update(PEPPER + '|' + chosen.join('|').toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

// For the About screen and for support: which signal identified this machine,
// never the value itself.
function hardwareSource(parts = components()) {
  if (usable(parts && parts.uuid) || usable(parts && parts.board)) return 'board';
  if (usable(parts && parts.guid)) return 'os-install';
  return 'none';
}

module.exports = { hardwareId, hardwareSource, components, usable, PLACEHOLDERS, os };
