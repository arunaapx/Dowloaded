const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'licenses.json');

const state = { keys: {}, events: [] };

function load() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    state.keys = obj.keys || {};
    state.events = obj.events || [];
  } catch (e) {
    console.error('[db] load failed:', e.message);
  }
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
    run(key, email, created_at, note) {
      state.keys[key] = {
        key,
        email: email || null,
        created_at,
        revoked: 0,
        device_id: null,
        device_name: null,
        activated_at: null,
        last_heartbeat: null,
        note: note || null,
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
