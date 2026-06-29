// Per-license usage caps + IP anomaly detection.
//
// Stops the main residual abuse in the thin-client model: a paying user turning
// their license into a free extraction API for many other people. We cap how
// much one key can extract per day and watch how many distinct IPs use it per
// hour — a single person hops a handful of networks; a resold key hits dozens.
//
// In-memory, per-process (fine for a single VPS; move to Redis if you scale out).

const DAILY_CAP = Math.max(1, parseInt(process.env.VELOX_DAILY_CAP || '300', 10));   // extract+resolve / key / day
const IP_WINDOW_MS = 60 * 60 * 1000;                                                  // rolling 1h
const IP_ALERT = Math.max(2, parseInt(process.env.VELOX_IP_ALERT || '6', 10));        // distinct IPs/h → flag
const IP_BLOCK = Math.max(IP_ALERT + 1, parseInt(process.env.VELOX_IP_BLOCK || '25', 10)); // distinct IPs/h → block

const state = new Map(); // key -> { day, count, ips: Map<ip, ts>, alerted }

function today() {
  return new Date().toISOString().slice(0, 10);
}

function entry(key) {
  let e = state.get(key);
  const d = today();
  if (!e || e.day !== d) {
    e = { day: d, count: 0, ips: new Map(), alerted: false };
    state.set(key, e);
  }
  return e;
}

// Call once per gated request. Returns:
//   { ok:true }                              — allowed
//   { ok:true, alert:true, distinct }        — allowed but suspicious (caller should log)
//   { ok:false, status, reason, ... }        — denied
function check(key, ip) {
  const e = entry(key);

  e.count += 1;
  if (e.count > DAILY_CAP) {
    return { ok: false, status: 429, reason: 'daily download limit reached, try again tomorrow' };
  }

  const now = Date.now();
  if (ip) e.ips.set(ip, now);
  for (const [k, ts] of e.ips) if (now - ts > IP_WINDOW_MS) e.ips.delete(k);
  const distinct = e.ips.size;

  if (distinct >= IP_BLOCK) {
    return { ok: false, status: 403, reason: 'this license is being used from too many devices', block: true, distinct };
  }
  if (distinct >= IP_ALERT && !e.alerted) {
    e.alerted = true;
    return { ok: true, alert: true, distinct };
  }
  return { ok: true, distinct };
}

function snapshot(key) {
  const e = state.get(key);
  if (!e || e.day !== today()) return { count: 0, distinctIps: 0, cap: DAILY_CAP };
  return { count: e.count, distinctIps: e.ips.size, cap: DAILY_CAP };
}

module.exports = { check, snapshot, DAILY_CAP, IP_ALERT, IP_BLOCK };
