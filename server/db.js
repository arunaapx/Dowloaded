const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'licenses.json');

// `settings` holds the knobs the admin panel can change at runtime. Anything
// absent here falls back to the env var, so an untouched install behaves
// exactly as it did before the panel gained a settings card.
const state = { keys: {}, events: [], devices: {}, settings: {} };

function load() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    state.keys = obj.keys || {};
    state.events = obj.events || [];
    state.devices = obj.devices || {};
    state.settings = obj.settings || {};
    migrate();
  } catch (e) {
    console.error('[db] load failed:', e.message);
  }
}

function migrate() {
  let changed = false;
  for (const k of Object.values(state.keys)) {
    if (typeof k.blocked === 'undefined') { k.blocked = 0; changed = true; }
    if (typeof k.blocked_at === 'undefined') { k.blocked_at = null; changed = true; }
    if (typeof k.block_reason === 'undefined') { k.block_reason = null; changed = true; }
    if (typeof k.expires_at === 'undefined') { k.expires_at = null; changed = true; }
    if (typeof k.note === 'undefined') { k.note = null; changed = true; }
    // Existing keys default to paid (trial=0) so real licenses are never capped.
    if (typeof k.trial === 'undefined') { k.trial = 0; changed = true; }
  }
  if (changed) scheduleSave();
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('[db] save failed:', e.message);
    }
  }, 50);
}

load();

// API mirrors better-sqlite3 prepared-statement shape (.run / .get / .all)
const stmts = {
  insertKey: {
    run(key, email, created_at, note, expires_at, trial) {
      state.keys[key] = {
        key,
        email: email || null,
        created_at,
        revoked: 0,
        blocked: 0,
        blocked_at: null,
        block_reason: null,
        device_id: null,
        device_name: null,
        activated_at: null,
        last_heartbeat: null,
        expires_at: expires_at || null,
        note: note || null,
        trial: trial ? 1 : 0,
      };
      scheduleSave();
      return { changes: 1 };
    },
  },
  findKey:   { get(key)   { return state.keys[key] || null; } },
  findEmail: { get(email) {
    for (const k of Object.values(state.keys)) {
      if (k.email && k.email.toLowerCase() === String(email).toLowerCase()) return k;
    }
    return null;
  } },
  allKeys: { all() {
    return Object.values(state.keys).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  } },
  revoke:   { run(key) { if (!state.keys[key]) return { changes: 0 }; state.keys[key].revoked = 1; scheduleSave(); return { changes: 1 }; } },
  unrevoke: { run(key) { if (!state.keys[key]) return { changes: 0 }; state.keys[key].revoked = 0; scheduleSave(); return { changes: 1 }; } },
  block: { run(key, reason, ts) {
    const r = state.keys[key];
    if (!r) return { changes: 0 };
    r.blocked = 1; r.block_reason = reason || null; r.blocked_at = ts || Date.now();
    scheduleSave();
    return { changes: 1 };
  } },
  unblock: { run(key) {
    const r = state.keys[key];
    if (!r) return { changes: 0 };
    r.blocked = 0; r.block_reason = null; r.blocked_at = null;
    scheduleSave();
    return { changes: 1 };
  } },
  updateKey: { run(key, email, note, expires_at) {
    const r = state.keys[key];
    if (!r) return { changes: 0 };
    r.email = email || null;
    r.note = note || null;
    r.expires_at = expires_at || null;
    scheduleSave();
    return { changes: 1 };
  } },
  delKey:   { run(key) { if (!state.keys[key]) return { changes: 0 }; delete state.keys[key]; scheduleSave(); return { changes: 1 }; } },
  resetDevice: { run(key) {
    const r = state.keys[key];
    if (!r) return { changes: 0 };
    r.device_id = null; r.device_name = null; r.activated_at = null; r.last_heartbeat = null;
    scheduleSave();
    return { changes: 1 };
  } },
  bindDevice: { run(deviceId, deviceName, activated_at, key) {
    const r = state.keys[key];
    if (!r) return { changes: 0 };
    r.device_id = deviceId; r.device_name = deviceName; r.activated_at = activated_at;
    scheduleSave();
    return { changes: 1 };
  } },
  bumpHeartbeat: { run(ts, key) {
    const r = state.keys[key];
    if (!r) return { changes: 0 };
    r.last_heartbeat = ts;
    scheduleSave();
    return { changes: 1 };
  } },
  // Device-locked trial ledger: tracks free downloads per device_id (permanent),
  // so swapping the email can't reset the free quota.
  getDevice: { get(deviceId) { return (deviceId && state.devices[deviceId]) || null; } },
  // --- hardware binding: one email <-> one device -------------------------
  // Written at registration and never by the user again. Only an admin
  // reset-device clears it, which is what makes "you cannot move yourself to a
  // new machine" true rather than merely inconvenient.
  bindDeviceEmail: { run(deviceId, email, key) {
    if (!deviceId) return { changes: 0 };
    const d = state.devices[deviceId] || { trialDownloads: 0, firstSeen: Date.now(), updatedAt: 0 };
    d.email = String(email || '').toLowerCase();
    d.key = key || null;
    d.boundAt = d.boundAt || Date.now();
    d.updatedAt = Date.now();
    state.devices[deviceId] = d;
    scheduleSave();
    return { changes: 1 };
  } },
  // Clears the email/key binding but deliberately KEEPS trialDownloads, so an
  // admin moving someone to a new machine never hands out a fresh free trial.
  clearDeviceBinding: { run(deviceId) {
    const d = deviceId && state.devices[deviceId];
    if (!d) return { changes: 0 };
    delete d.email; delete d.key; delete d.boundAt;
    d.updatedAt = Date.now();
    scheduleSave();
    return { changes: 1 };
  } },
  findDeviceByEmail: { get(email) {
    const wanted = String(email || '').trim().toLowerCase();
    if (!wanted) return null;
    for (const [id, d] of Object.entries(state.devices)) {
      if (d.email && d.email === wanted) return { deviceId: id, ...d };
    }
    return null;
  } },
  // --- runtime settings, editable from the admin panel --------------------
  getSettings: { get() { return { ...state.settings }; } },
  saveSettings: { run(patch) {
    Object.assign(state.settings, patch);
    scheduleSave();
    return { changes: 1 };
  } },

  // --- device ledger admin ------------------------------------------------
  allDevices: { all() {
    return Object.entries(state.devices)
      .map(([id, d]) => ({ deviceId: id, ...d }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } },
  // Hands a machine a fresh free trial. Separate from clearDeviceBinding on
  // purpose: unbinding an account and granting new downloads are different
  // decisions and should not happen by accident.
  resetDeviceTrial: { run(deviceId) {
    const d = deviceId && state.devices[deviceId];
    if (!d) return { changes: 0 };
    d.trialDownloads = 0;
    d.updatedAt = Date.now();
    scheduleSave();
    return { changes: 1 };
  } },
  deleteDevice: { run(deviceId) {
    if (!deviceId || !state.devices[deviceId]) return { changes: 0 };
    delete state.devices[deviceId];
    scheduleSave();
    return { changes: 1 };
  } },
  // Lift the trial cap on a key (someone paid outside the PayPal flow).
  setKeyPaid: { run(key) {
    const r = state.keys[key];
    if (!r) return { changes: 0 };
    r.trial = 0;
    scheduleSave();
    return { changes: 1 };
  } },

  // Every device a key has been bound to - used by admin reset to unbind them.
  devicesForKey: { all(key) {
    return Object.entries(state.devices)
      .filter(([, d]) => d.key === key)
      .map(([id, d]) => ({ deviceId: id, ...d }));
  } },
  bumpDeviceTrial: { run(deviceId) {
    if (!deviceId) return { changes: 0 };
    const d = state.devices[deviceId] || { trialDownloads: 0, firstSeen: Date.now(), updatedAt: 0 };
    d.trialDownloads = (d.trialDownloads || 0) + 1;
    d.updatedAt = Date.now();
    state.devices[deviceId] = d;
    scheduleSave();
    return { changes: 1, trialDownloads: d.trialDownloads };
  } },
  logEvent: { run(at, type, key, ip, detail) {
    state.events.push({ id: state.events.length + 1, at, type, key, ip, detail });
    if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
    scheduleSave();
    return { changes: 1 };
  } },
  recentEvents: { all() {
    return [...state.events].sort((a, b) => b.at - a.at).slice(0, 200);
  } },
};

function logEvent(type, key, ip, detail) {
  try { stmts.logEvent.run(Date.now(), type, key || null, ip || null, detail || null); } catch {}
}

module.exports = { stmts, logEvent };
