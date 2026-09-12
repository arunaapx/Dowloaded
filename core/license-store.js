// Where the licence lives on disk, and why it does not look like a licence.
//
// It used to be userData/license.json: plain JSON, obvious name, readable and
// editable by anyone who opened the folder, and copyable to a second PC. Now
// both the name and the contents come from the machine itself.
//
//   * the file name is a hash of this machine's hardware id, so there is
//     nothing to search for — no "license.json", and the name differs on every
//     PC, so an instruction like "delete X and paste Y" does not travel;
//   * the contents are AES-256-GCM, with the key derived from the same
//     hardware id. Copied to another machine the file is noise: the key is not
//     in it, and the machine it came from is not the machine reading it.
//
// ── What this is and is not ──────────────────────────────────────────────
// This is a lock on the front door, not a vault. The app's own JavaScript
// ships in app.asar, which anyone can unpack, and it says exactly how the key
// is derived. Someone determined will get past it — that is true of every
// desktop licence, including the ones sold by companies far larger than this
// one. What it stops is the ordinary case: a customer poking around in
// AppData, a "paste this file to activate" post, and a licence that travels
// between machines by copying one file.
//
// The enforcement that actually holds is on the server: the device limit, the
// trial counter and the heartbeat. This only makes the client side worth less
// to attack.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME_PEPPER = 'velox-store-name-v1';
const KEY_PEPPER = 'velox-store-key-v1';
const MAGIC = Buffer.from('VLX1');          // so a stray file is recognised, not parsed as junk
const LEGACY_NAME = 'license.json';

// A machine with no hardware id still needs somewhere to put this, so the
// fallback is a fixed string: the file is still encrypted at rest, it is simply
// not tied to that machine. Those are the machines that already fall back to
// the old device id, so nothing is lost that was there before.
function seed(hardwareId) {
  return hardwareId && String(hardwareId).trim() ? String(hardwareId).trim().toLowerCase() : 'no-hardware-id';
}

// 24 hex characters and a dull extension. Nothing in the name says licence, and
// two machines never produce the same one.
function storeName(hardwareId) {
  return crypto.createHash('sha256').update(NAME_PEPPER + '|' + seed(hardwareId)).digest('hex').slice(0, 24) + '.dat';
}

function storePath(dir, hardwareId) {
  return path.join(dir, storeName(hardwareId));
}

function keyFor(hardwareId) {
  return crypto.createHash('sha256').update(KEY_PEPPER + '|' + seed(hardwareId)).digest();
}

// [ MAGIC | iv (12) | tag (16) | ciphertext ]
function encrypt(obj, hardwareId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(hardwareId), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function decrypt(buf, hardwareId) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + 28) return null;
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const body = buf.subarray(MAGIC.length + 28);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(hardwareId), iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(body), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    // Wrong machine, edited bytes, or a half-written file. All three mean the
    // same thing to the app: there is no licence here.
    return null;
  }
}

// An older install still has the plain file. It is read once, rewritten in the
// new form and removed, so nobody has to activate again for this change.
function migrateLegacy(dir, hardwareId) {
  const legacy = path.join(dir, LEGACY_NAME);
  try {
    if (!fs.existsSync(legacy)) return null;
    const obj = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    write(dir, hardwareId, obj);
    try { fs.unlinkSync(legacy); } catch {}
    return obj;
  } catch {
    try { fs.unlinkSync(legacy); } catch {}
    return null;
  }
}

function read(dir, hardwareId) {
  try {
    const file = storePath(dir, hardwareId);
    if (!fs.existsSync(file)) return migrateLegacy(dir, hardwareId);
    return decrypt(fs.readFileSync(file), hardwareId);
  } catch {
    return null;
  }
}

function write(dir, hardwareId, obj) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = storePath(dir, hardwareId);
    // Written aside and renamed: a licence half-written by a power cut would
    // lock the customer out of what they paid for.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, encrypt(obj, hardwareId));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function clear(dir, hardwareId) {
  for (const f of [storePath(dir, hardwareId), path.join(dir, LEGACY_NAME)]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

module.exports = { read, write, clear, storeName, storePath, migrateLegacy };
