//! The rules a licence lives by, and the shapes the app is told about them.
//!
//! Everything that decides whether someone may download is here: what state a
//! key is in, how many machines it covers, how much of a trial is left, which
//! notices reach whom, and which plans a customer is allowed to see. The route
//! handlers above this only translate HTTP; the decisions are all made here, so
//! they can be tested without a socket.

use crate::db::Db;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A key, as the ledger holds it.
#[derive(Debug, Clone)]
pub struct Key {
    pub key: String,
    pub email: Option<String>,
    pub created_at: Option<i64>,
    pub revoked: bool,
    pub blocked: bool,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub activated_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub note: Option<String>,
    pub trial: bool,
    pub plan: Option<String>,
    pub device_limit: Option<i64>,
}

const KEY_COLUMNS: &str =
    "key, email, created_at, revoked, blocked, device_id, device_name, activated_at, expires_at, note, trial, plan, device_limit";

fn key_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Key> {
    Ok(Key {
        key: r.get(0)?,
        email: r.get(1)?,
        created_at: r.get(2)?,
        revoked: r.get::<_, i64>(3)? != 0,
        blocked: r.get::<_, i64>(4)? != 0,
        device_id: r.get(5)?,
        device_name: r.get(6)?,
        activated_at: r.get(7)?,
        expires_at: r.get(8)?,
        note: r.get(9)?,
        trial: r.get::<_, i64>(10)? != 0,
        plan: r.get(11)?,
        device_limit: r.get(12)?,
    })
}

/// What a key is, right now. The order matters: a revoked key is revoked even
/// after it expires, because that is the one an admin took away on purpose.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum State {
    Missing,
    Revoked,
    Blocked,
    Expired,
    /// Issued but never used on a machine.
    Pending,
    Active,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Missing => "missing",
            State::Revoked => "revoked",
            State::Blocked => "blocked",
            State::Expired => "expired",
            State::Pending => "pending",
            State::Active => "active",
        }
    }
}

pub fn state_of(key: &Key) -> State {
    if key.revoked {
        return State::Revoked;
    }
    if key.blocked {
        return State::Blocked;
    }
    if key.expires_at.is_some_and(|e| e <= now_ms()) {
        return State::Expired;
    }
    if key.device_id.is_some() {
        State::Active
    } else {
        State::Pending
    }
}

pub fn days_remaining(expires_at: Option<i64>) -> Option<i64> {
    expires_at.map(|e| ((e - now_ms()) as f64 / DAY_MS as f64).ceil().max(0.0) as i64)
}

// ------------------------------------------------------------------ settings

/// The admin panel's knobs, with the same fallbacks the Node server uses.
pub struct Settings {
    pub signup_enabled: bool,
    pub trial_downloads: i64,
    pub default_license_days: i64,
    pub default_device_limit: i64,
}

/// Sign-ups per hour from one address. Its own function because it is a rate
/// limit rather than a licence rule, and 0 — meaning no limit — is a value an
/// operator sets on purpose, so it cannot share the "at least 1" floor the
/// others have.
pub fn signup_per_hour(db: &Db, fallback: i64) -> i64 {
    db.setting("signupPerHour")
        .ok()
        .flatten()
        .and_then(|v| v.as_i64())
        .filter(|n| *n >= 0)
        .unwrap_or(fallback)
}

pub fn settings(db: &Db, defaults: (i64, i64, i64)) -> Settings {
    let (trial, days, devices) = defaults;
    let number = |name: &str, fallback: i64, min: i64| {
        db.setting(name)
            .ok()
            .flatten()
            .and_then(|v| v.as_i64())
            .filter(|n| *n >= min)
            .unwrap_or(fallback)
    };
    Settings {
        signup_enabled: db
            .setting("signupEnabled")
            .ok()
            .flatten()
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        trial_downloads: number("trialDownloads", trial, 1),
        default_license_days: number("defaultLicenseDays", days, 0),
        default_device_limit: number("defaultDeviceLimit", devices, 1),
    }
}

// -------------------------------------------------------------------- keys

pub fn find_key(db: &Db, key: &str) -> Option<Key> {
    let conn = db.lock();
    conn.query_row(
        &format!("SELECT {KEY_COLUMNS} FROM keys WHERE key = ?1"),
        [key],
        key_from_row,
    )
    .optional()
    .ok()
    .flatten()
}

/// Sign-up finds an existing customer by address, and addresses are compared
/// without case everywhere else, so this does too.
pub fn find_by_email(db: &Db, email: &str) -> Option<Key> {
    let conn = db.lock();
    conn.query_row(
        &format!("SELECT {KEY_COLUMNS} FROM keys WHERE lower(email) = lower(?1) LIMIT 1"),
        [email],
        key_from_row,
    )
    .optional()
    .ok()
    .flatten()
}

pub fn insert_key(
    db: &Db,
    key: &str,
    email: Option<&str>,
    note: &str,
    expires_at: Option<i64>,
    trial: bool,
) -> rusqlite::Result<()> {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO keys (key, email, created_at, note, expires_at, trial) VALUES (?1,?2,?3,?4,?5,?6)",
        params![key, email, now_ms(), note, expires_at, trial as i64],
    )?;
    Ok(())
}

pub fn touch_heartbeat(db: &Db, key: &str) {
    let conn = db.lock();
    let _ = conn.execute("UPDATE keys SET last_heartbeat = ?1 WHERE key = ?2", params![now_ms(), key]);
}

// ----------------------------------------------------------------- devices

/// Every machine this key is registered on.
///
/// The ledger is the record, but a key bound before the ledger existed only has
/// device_id on the key itself, so both are counted — otherwise an upgrade
/// would silently unbind every older customer.
pub fn bound_devices(db: &Db, key: &Key) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(primary) = &key.device_id {
        ids.push(primary.clone());
    }
    let conn = db.lock();
    if let Ok(mut stmt) = conn.prepare("SELECT device_id FROM devices WHERE key = ?1") {
        if let Ok(rows) = stmt.query_map([&key.key], |r| r.get::<_, String>(0)) {
            for id in rows.flatten() {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    ids
}

/// How many machines this key may run on: its own number first, then whatever
/// its plan allows, then the default. Raising a plan therefore lifts every key
/// sold on it, without touching them one by one.
pub fn device_limit(db: &Db, key: &Key, fallback: i64) -> i64 {
    if let Some(own) = key.device_limit.filter(|n| *n >= 1) {
        return own;
    }
    if let Some(plan_id) = &key.plan {
        let conn = db.lock();
        let from_plan: Option<i64> = conn
            .query_row("SELECT devices FROM plans WHERE id = ?1", [plan_id], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        if let Some(n) = from_plan.filter(|n| *n >= 1) {
            return n;
        }
    }
    fallback
}

pub struct DeviceCheck {
    pub allowed: bool,
    /// Already registered on this key — a reinstall, not a new machine.
    pub known: bool,
    pub used: usize,
    pub limit: i64,
}

pub fn device_allowed(db: &Db, key: &Key, device_id: &str, fallback_limit: i64) -> DeviceCheck {
    let bound = bound_devices(db, key);
    let limit = device_limit(db, key, fallback_limit);
    let known = bound.iter().any(|d| d == device_id);
    DeviceCheck {
        allowed: known || (bound.len() as i64) < limit,
        known,
        used: bound.len(),
        limit,
    }
}

/// What a customer is told when their machine is turned away. One machine reads
/// as the rule they already know; more than one says where they stand.
pub fn device_limit_message(check: &DeviceCheck) -> String {
    if check.limit == 1 {
        "This key is already connected with another device. Contact support to move it.".to_string()
    } else {
        format!(
            "This key is already in use on {} of {} devices. Remove one, or contact support.",
            check.used, check.limit
        )
    }
}

/// Registers a machine against a key: in the ledger, and on the key itself when
/// it is the first, so anything reading key.device_id still sees a device.
pub fn bind_device(db: &Db, key: &Key, device_id: &str, device_name: &str) {
    let conn = db.lock();
    if key.device_id.is_none() {
        let _ = conn.execute(
            "UPDATE keys SET device_id = ?1, device_name = ?2, activated_at = ?3 WHERE key = ?4",
            params![device_id, device_name, now_ms(), key.key],
        );
    }
    let _ = conn.execute(
        "INSERT INTO devices (device_id, email, key, name, first_seen, bound_at, updated_at)
         VALUES (?1, lower(?2), ?3, ?4, ?5, ?5, ?5)
         ON CONFLICT(device_id) DO UPDATE SET
           key = excluded.key,
           email = COALESCE(excluded.email, devices.email),
           name = COALESCE(excluded.name, devices.name),
           bound_at = COALESCE(devices.bound_at, excluded.bound_at),
           updated_at = excluded.updated_at",
        params![device_id, key.email, key.key, device_name, now_ms()],
    );
}

pub struct Device {
    pub email: Option<String>,
    pub trial_downloads: i64,
}

pub fn find_device(db: &Db, device_id: &str) -> Option<Device> {
    let conn = db.lock();
    conn.query_row(
        "SELECT email, trial_downloads FROM devices WHERE device_id = ?1",
        [device_id],
        |r| Ok(Device { email: r.get(0)?, trial_downloads: r.get(1)? }),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn spend_trial_download(db: &Db, device_id: &str) {
    let conn = db.lock();
    let _ = conn.execute(
        "INSERT INTO devices (device_id, trial_downloads, first_seen, updated_at) VALUES (?1, 1, ?2, ?2)
         ON CONFLICT(device_id) DO UPDATE SET trial_downloads = devices.trial_downloads + 1, updated_at = ?2",
        params![device_id, now_ms()],
    );
}

/// Free downloads left on a trial key's machine — the count lives on the
/// machine, so a new email cannot hand anyone a fresh trial.
pub fn trial_remaining(db: &Db, key: &Key, cap: i64) -> Option<i64> {
    if !key.trial {
        return None;
    }
    let used = key
        .device_id
        .as_deref()
        .and_then(|id| find_device(db, id))
        .map(|d| d.trial_downloads)
        .unwrap_or(0);
    Some((cap - used).max(0))
}

// ------------------------------------------------------------------- usage

pub fn today() -> String {
    // The day the ledger counts in, in UTC, matching the Node server.
    let secs = now_ms() / 1000;
    let days = secs / 86_400;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's civil-from-days, so a date needs no dependency.
pub fn civil_from_days_pub(z: i64) -> (i64, u32, u32) {
    civil_from_days(z)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn downloads_today(db: &Db, key: &str) -> i64 {
    let conn = db.lock();
    conn.query_row(
        "SELECT count FROM usage WHERE key = ?1 AND day = ?2",
        params![key, today()],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(0)
}

pub fn bump_usage(db: &Db, key: &str) {
    let conn = db.lock();
    let _ = conn.execute(
        "INSERT INTO usage (key, day, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key, day) DO UPDATE SET count = usage.count + 1",
        params![key, today()],
    );
}

// ------------------------------------------------------------------- plans

#[derive(Debug, Serialize)]
pub struct PublicPlan {
    pub id: String,
    pub name: String,
    pub price: String,
    pub period: String,
    pub devices: i64,
    pub features: Vec<String>,
    pub highlight: bool,
    #[serde(rename = "buyUrl")]
    pub buy_url: String,
    pub order: i64,
}

/// Only plans someone finished: priced and published. An unpriced or
/// unpublished plan stays in the admin panel and never reaches a customer, so a
/// half-written price cannot ship.
pub fn public_plans(db: &Db) -> Vec<PublicPlan> {
    let conn = db.lock();
    let mut stmt = match conn.prepare(
        "SELECT id, name, price, period, devices, features, highlight, buy_url, ord
         FROM plans WHERE active = 1 AND price IS NOT NULL AND trim(price) <> '' ORDER BY ord, name",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        let features: String = r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "[]".into());
        Ok(PublicPlan {
            id: r.get(0)?,
            name: r.get(1)?,
            price: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            period: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            devices: r.get(4)?,
            features: serde_json::from_str(&features).unwrap_or_default(),
            highlight: r.get::<_, i64>(6)? != 0,
            buy_url: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
            order: r.get(8)?,
        })
    });
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

/// What the app is told about the plan a key sits on. A trial has no plan of
/// its own, so it is named as the trial it is.
pub fn plan_for(db: &Db, key: &Key) -> Value {
    if key.trial {
        return json!({ "id": Value::Null, "name": "Free trial", "features": [] });
    }
    let plan = key.plan.as_ref().and_then(|id| {
        let conn = db.lock();
        conn.query_row(
            "SELECT id, name, price, period, devices, features FROM plans WHERE id = ?1",
            [id],
            |r| {
                let features: String = r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "[]".into());
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "price": r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    "period": r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    "devices": r.get::<_, i64>(4)?,
                    "features": serde_json::from_str::<Vec<String>>(&features).unwrap_or_default(),
                }))
            },
        )
        .optional()
        .ok()
        .flatten()
    });
    plan.unwrap_or_else(|| json!({ "id": Value::Null, "name": "Licensed", "features": [] }))
}

// ----------------------------------------------------------------- notices

/// Who a notice is for. `trial-exhausted` is the moment worth catching: the
/// person has spent every free download and is looking at a wall, which is
/// exactly when an upgrade offer is worth showing.
pub fn notice_matches(audience: &str, key: &Key, trial_left: Option<i64>) -> bool {
    let expired = key.expires_at.is_some_and(|e| e <= now_ms());
    match audience {
        "all" => true,
        "expired" => expired,
        "trial" => key.trial && !expired,
        "paid" => !key.trial && !expired,
        "trial-exhausted" => key.trial && !expired && trial_left == Some(0),
        _ => false,
    }
}

pub fn notices_for(db: &Db, key: &Key, trial_left: Option<i64>) -> Vec<Value> {
    let conn = db.lock();
    let mut stmt = match conn.prepare(
        "SELECT id, title, body, audience, level, action_label, action_url, created_at
         FROM notices WHERE active = 1 ORDER BY created_at DESC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "body": r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "level": r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "info".into()),
                "actionLabel": r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                "actionUrl": r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                "createdAt": r.get::<_, Option<i64>>(7)?.unwrap_or(0),
            }),
            r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "all".into()),
        ))
    });
    match rows {
        Ok(iter) => iter
            .flatten()
            .filter(|(_, audience)| notice_matches(audience, key, trial_left))
            .map(|(value, _)| value)
            .collect(),
        Err(_) => Vec::new(),
    }
}

// ----------------------------------------------------------------- profile

/// Everything the Account screen shows, in one place so activation and the
/// heartbeat can never disagree about it.
pub fn public_profile(db: &Db, key: &Key, trial_cap: i64, fallback_limit: i64) -> Value {
    let trial_left = trial_remaining(db, key, trial_cap);
    json!({
        "key": key.key,
        "email": key.email.clone().unwrap_or_default(),
        "note": key.note.clone().unwrap_or_default(),
        "deviceName": key.device_name.clone().unwrap_or_default(),
        "expiresAt": key.expires_at,
        "daysRemaining": days_remaining(key.expires_at),
        "status": state_of(key).as_str(),
        "trial": key.trial,
        "trialTotal": if key.trial { Some(trial_cap) } else { None },
        "trialRemaining": trial_left,
        "plan": plan_for(db, key),
        "downloadsToday": downloads_today(db, &key.key),
        "devices": {
            "used": bound_devices(db, key).len(),
            "limit": device_limit(db, key, fallback_limit),
        },
    })
}

// -------------------------------------------------------------------- keys

const KEY_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// VLX-XXXXX-XXXXX-XXXXX, from an alphabet with no characters anyone can
/// misread aloud: no O against 0, no I against 1.
pub fn make_key() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut block = || -> String {
        (0..5).map(|_| KEY_ALPHABET[rng.gen_range(0..KEY_ALPHABET.len())] as char).collect()
    };
    format!("VLX-{}-{}-{}", block(), block(), block())
}

pub fn normalize_key(v: &str) -> String {
    v.trim().to_uppercase().replace(char::is_whitespace, "")
}

pub fn email_ok(v: &str) -> bool {
    let v = v.trim();
    v.len() <= 200
        && !v.contains(char::is_whitespace)
        && v.matches('@').count() == 1
        && v.split('@').nth(1).is_some_and(|domain| domain.contains('.') && domain.len() > 2)
        && v.split('@').next().is_some_and(|local| !local.is_empty())
}

/// Enough for the real owner to recognise their own address, not enough to leak
/// a stranger's to whoever is sitting at the machine.
pub fn mask_email(v: &str) -> String {
    let (local, domain) = match v.split_once('@') {
        Some(parts) => parts,
        None => return "***".into(),
    };
    let head: String = local.chars().take(2).collect();
    format!("{head}***@{domain}")
}

pub fn log_event(db: &Db, kind: &str, key: Option<&str>, ip: &str, detail: &str) {
    let conn = db.lock();
    let _ = conn.execute(
        "INSERT OR IGNORE INTO events (at, type, key, ip, detail) VALUES (?1,?2,?3,?4,?5)",
        params![now_ms(), kind, key, ip, detail],
    );
}

// ============================================================ the admin side
//
// Everything below exists for the admin panel: the whole ledger as a table, and
// the changes an operator makes to it. The rules above decide what a licence
// *is*; these are the levers a person pulls when a customer writes in.
//
// Each mutation reports how many rows it changed, because the panel tells the
// operator whether anything actually happened — "0 changed" on a key that was
// deleted in another tab is information, not an error.

/// One key as the admin table shows it: the stored row, plus what has to be
/// worked out (its state, how much of a trial is spent, how many machines).
pub fn admin_keys(db: &Db, trial_cap: i64, fallback_limit: i64) -> Vec<Value> {
    // Read the rows out and let the lock go before working anything out about
    // them: each key below asks the ledger more questions of its own.
    let keys: Vec<Key> = {
        let conn = db.lock();
        conn.prepare(&format!("SELECT {KEY_COLUMNS} FROM keys ORDER BY created_at DESC"))
            .and_then(|mut stmt| stmt.query_map([], key_from_row).map(|rows| rows.flatten().collect()))
            .unwrap_or_default()
    };
    keys.iter().map(|k| admin_key_value(db, k, trial_cap, fallback_limit)).collect()
}

pub fn admin_key(db: &Db, key: &str, trial_cap: i64, fallback_limit: i64) -> Option<Value> {
    find_key(db, key).map(|row| admin_key_value(db, &row, trial_cap, fallback_limit))
}

/// The stored column names are kept exactly as they are (`created_at`, not
/// `createdAt`): the panel's HTML reads them, and both servers answer it.
fn admin_key_value(db: &Db, key: &Key, trial_cap: i64, fallback_limit: i64) -> Value {
    let extra = {
        let conn = db.lock();
        conn.query_row(
            "SELECT blocked_at, block_reason, last_heartbeat FROM keys WHERE key = ?1",
            [&key.key],
            |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()
    };
    let (blocked_at, block_reason, last_heartbeat) = extra.unwrap_or((None, None, None));
    // A trial's spend lives on its machine, so the count comes from there.
    let trial_used = if key.trial {
        key.device_id.as_deref().and_then(|id| find_device(db, id)).map(|d| d.trial_downloads).unwrap_or(0)
    } else {
        0
    };

    json!({
        "key": key.key,
        "email": key.email,
        "created_at": key.created_at,
        "revoked": key.revoked as i64,
        "blocked": key.blocked as i64,
        "blocked_at": blocked_at,
        "block_reason": block_reason,
        "device_id": key.device_id,
        "device_name": key.device_name,
        "activated_at": key.activated_at,
        "last_heartbeat": last_heartbeat,
        "expires_at": key.expires_at,
        "note": key.note,
        "plan": key.plan,
        "device_limit": key.device_limit,
        "status": state_of(key).as_str(),
        "days_remaining": days_remaining(key.expires_at),
        "trial": key.trial,
        "trial_used": trial_used,
        "trial_total": if key.trial { Some(trial_cap) } else { None },
        "devices_used": bound_devices(db, key).len(),
        "devices_limit": device_limit(db, key, fallback_limit),
    })
}

/// The audit log, newest first. Capped because the panel renders every row it
/// is given, and nobody reads the four thousandth heartbeat.
pub fn recent_events(db: &Db, limit: i64) -> Vec<Value> {
    let conn = db.lock();
    let mut stmt = match conn.prepare("SELECT at, type, key, ip, detail FROM events ORDER BY at DESC, id DESC LIMIT ?1") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([limit], |r| {
        Ok(json!({
            "at": r.get::<_, Option<i64>>(0)?,
            "type": r.get::<_, Option<String>>(1)?,
            "key": r.get::<_, Option<String>>(2)?,
            "ip": r.get::<_, Option<String>>(3)?,
            "detail": r.get::<_, Option<String>>(4)?,
        }))
    });
    rows.map(|iter| iter.flatten().collect()).unwrap_or_default()
}

// ------------------------------------------------------------------- plans

/// Every plan, drafts included — this is the editor's view, not a customer's.
pub fn all_plans(db: &Db) -> Vec<Value> {
    let conn = db.lock();
    let mut stmt = match conn.prepare(
        "SELECT id, name, price, period, devices, features, highlight, active, buy_url, ord
         FROM plans ORDER BY ord, name",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        let features: String = r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "[]".into());
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "name": r.get::<_, String>(1)?,
            "price": r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            "period": r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            "devices": r.get::<_, i64>(4)?,
            "features": serde_json::from_str::<Vec<String>>(&features).unwrap_or_default(),
            "highlight": r.get::<_, i64>(6)? != 0,
            "active": r.get::<_, i64>(7)? != 0,
            "buyUrl": r.get::<_, Option<String>>(8)?.unwrap_or_default(),
            "order": r.get::<_, i64>(9)?,
        }))
    });
    rows.map(|iter| iter.flatten().collect()).unwrap_or_default()
}

/// The three tiers the product sells on, so the panel opens with a table to edit
/// rather than a blank page.
///
/// They arrive unpriced and unpublished on purpose: nothing reaches a customer
/// until someone types a real price and ticks Published. Seeded once — deleting
/// them all does not bring them back, because an operator who cleared the table
/// meant to.
pub fn seed_plans(db: &Db) -> bool {
    let already = db.setting("plansSeeded").ok().flatten().and_then(|v| v.as_bool()).unwrap_or(false);
    if already || !all_plans(db).is_empty() {
        return false;
    }

    let included = [
        "Unlimited downloads",
        "Up to 4K, playlists and subtitles",
        "Torrents, games and software",
        "Every update while your plan is active",
    ];
    let with = |extra: &str| -> Vec<String> {
        included.iter().map(|s| s.to_string()).chain(std::iter::once(extra.to_string())).collect()
    };

    let plans = vec![
        PlanRow {
            id: "monthly".into(),
            name: "1 Month".into(),
            price: String::new(),
            period: "per month".into(),
            devices: 1,
            features: included.iter().map(|s| s.to_string()).collect(),
            highlight: false,
            active: false,
            buy_url: String::new(),
            order: 1,
        },
        PlanRow {
            id: "yearly".into(),
            name: "1 Year".into(),
            price: String::new(),
            period: "per year".into(),
            devices: 2,
            features: with("Two months free vs monthly"),
            highlight: true,
            active: false,
            buy_url: String::new(),
            order: 2,
        },
        PlanRow {
            id: "lifetime".into(),
            name: "Lifetime".into(),
            price: String::new(),
            period: "one time".into(),
            devices: 3,
            features: with("Pay once, yours for good"),
            highlight: false,
            active: false,
            buy_url: String::new(),
            order: 3,
        },
    ];
    if save_plans(db, &plans).is_err() {
        return false;
    }
    let _ = db.set_setting("plansSeeded", &json!(true));
    true
}

pub struct PlanRow {
    pub id: String,
    pub name: String,
    pub price: String,
    pub period: String,
    pub devices: i64,
    pub features: Vec<String>,
    pub highlight: bool,
    pub active: bool,
    pub buy_url: String,
    pub order: i64,
}

/// The panel edits the pricing table as one list, so it is saved as one list: a
/// plan that is no longer in it has been deleted.
///
/// One transaction, because the moment between "delete everything" and "write
/// the new table" is a moment when the website has no prices.
pub fn save_plans(db: &Db, plans: &[PlanRow]) -> rusqlite::Result<()> {
    let mut conn = db.lock();
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM plans", [])?;
    for p in plans {
        tx.execute(
            "INSERT INTO plans (id, name, price, period, devices, features, highlight, active, buy_url, ord)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                p.id,
                p.name,
                p.price,
                p.period,
                p.devices,
                serde_json::to_string(&p.features).unwrap_or_else(|_| "[]".into()),
                p.highlight as i64,
                p.active as i64,
                p.buy_url,
                p.order,
            ],
        )?;
    }
    tx.commit()
}

pub fn plan_exists(db: &Db, id: &str) -> bool {
    let conn = db.lock();
    conn.query_row("SELECT 1 FROM plans WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

// ----------------------------------------------------------------- notices

pub struct NoticeRow {
    pub title: String,
    pub body: String,
    pub audience: String,
    pub level: String,
    pub action_label: String,
    pub action_url: String,
    pub active: bool,
}

pub fn all_notices(db: &Db) -> Vec<Value> {
    let conn = db.lock();
    let mut stmt = match conn.prepare(
        "SELECT id, title, body, audience, level, action_label, action_url, active, created_at, updated_at
         FROM notices ORDER BY created_at DESC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "title": r.get::<_, String>(1)?,
            "body": r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            "audience": r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "all".into()),
            "level": r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "info".into()),
            "actionLabel": r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            "actionUrl": r.get::<_, Option<String>>(6)?.unwrap_or_default(),
            "active": r.get::<_, i64>(7)? != 0,
            "created_at": r.get::<_, Option<i64>>(8)?,
            "updated_at": r.get::<_, Option<i64>>(9)?,
        }))
    });
    rows.map(|iter| iter.flatten().collect()).unwrap_or_default()
}

pub fn count_notices(db: &Db) -> i64 {
    let conn = db.lock();
    conn.query_row("SELECT COUNT(*) FROM notices", [], |r| r.get(0)).unwrap_or(0)
}

pub fn find_notice(db: &Db, id: &str) -> Option<Value> {
    all_notices(db).into_iter().find(|n| n["id"] == json!(id))
}

/// A short id that is not a number: notices are referred to in URLs, and a
/// guessable counter invites someone to walk the list.
pub fn new_notice_id() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..10).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
}

pub fn insert_notice(db: &Db, id: &str, n: &NoticeRow) -> rusqlite::Result<()> {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO notices (id, title, body, audience, level, action_label, action_url, active, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
        params![id, n.title, n.body, n.audience, n.level, n.action_label, n.action_url, n.active as i64, now_ms()],
    )?;
    Ok(())
}

pub fn update_notice(db: &Db, id: &str, n: &NoticeRow) -> usize {
    let conn = db.lock();
    conn.execute(
        "UPDATE notices SET title=?2, body=?3, audience=?4, level=?5, action_label=?6, action_url=?7,
                            active=?8, updated_at=?9 WHERE id=?1",
        params![id, n.title, n.body, n.audience, n.level, n.action_label, n.action_url, n.active as i64, now_ms()],
    )
    .unwrap_or(0)
}

/// Switching one on or off is the common edit, and it must not require sending
/// the whole notice back — a round trip that could overwrite someone else's.
pub fn set_notice_active(db: &Db, id: &str, active: bool) -> usize {
    let conn = db.lock();
    conn.execute(
        "UPDATE notices SET active = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, active as i64, now_ms()],
    )
    .unwrap_or(0)
}

pub fn delete_notice(db: &Db, id: &str) -> usize {
    let conn = db.lock();
    conn.execute("DELETE FROM notices WHERE id = ?1", [id]).unwrap_or(0)
}

// ----------------------------------------------------- the hardware ledger

/// Every machine that has ever registered, with what the trial has left on it.
pub fn all_devices(db: &Db, trial_cap: i64) -> Vec<Value> {
    type DeviceRow = (String, Option<String>, Option<String>, Option<String>, i64, Option<i64>, Option<i64>, Option<i64>);
    // Same as above: the lock goes before each machine is asked about its key.
    let rows: Vec<DeviceRow> = {
        let conn = db.lock();
        conn.prepare(
            "SELECT device_id, email, key, name, trial_downloads, first_seen, bound_at, updated_at
             FROM devices ORDER BY updated_at DESC",
        )
        .and_then(|mut stmt| {
            stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
            })
            .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default()
    };

    rows.into_iter()
        .map(|(device_id, email, key, name, trial_downloads, first_seen, bound_at, updated_at)| {
            // Whether the key it sits on is any good — the panel shows a machine
            // bound to a revoked key differently from a working one.
            let key_status = key
                .as_deref()
                .map(|k| find_key(db, k).map(|row| state_of(&row)).unwrap_or(State::Missing).as_str());
            json!({
                "deviceId": device_id,
                "email": email,
                "key": key,
                "name": name,
                "trialDownloads": trial_downloads,
                "trialRemaining": (trial_cap - trial_downloads).max(0),
                "firstSeen": first_seen,
                "boundAt": bound_at,
                "updatedAt": updated_at,
                "keyStatus": key_status,
            })
        })
        .collect()
}

/// Hand one machine its free downloads back. Deliberately separate from
/// unbinding: forgiving a trial and moving an account are different decisions,
/// and neither should happen by accident.
pub fn reset_device_trial(db: &Db, device_id: &str) -> usize {
    let conn = db.lock();
    conn.execute(
        "UPDATE devices SET trial_downloads = 0, updated_at = ?2 WHERE device_id = ?1",
        params![device_id, now_ms()],
    )
    .unwrap_or(0)
}

/// Free a machine so a different account can register on it. The trial count
/// stays, so unbinding is not a way to farm fresh trials.
pub fn clear_device_binding(db: &Db, device_id: &str) -> usize {
    let conn = db.lock();
    conn.execute(
        "UPDATE devices SET key = NULL, email = NULL, bound_at = NULL, updated_at = ?2 WHERE device_id = ?1",
        params![device_id, now_ms()],
    )
    .unwrap_or(0)
}

pub fn delete_device(db: &Db, device_id: &str) -> usize {
    let conn = db.lock();
    conn.execute("DELETE FROM devices WHERE device_id = ?1", [device_id]).unwrap_or(0)
}

/// Take one machine off its key.
///
/// The key also points at a "primary" machine, for the admin table and for
/// licences bound before the ledger existed. When the machine being removed is
/// that one, another of the key's machines takes its place: removing a
/// customer's second PC must not disturb their first.
///
/// Returns the key it was on, for the audit log.
pub fn detach_device_from_key(db: &Db, device_id: &str) -> Option<String> {
    let owner: Option<String> = {
        let conn = db.lock();
        conn.query_row("SELECT key FROM devices WHERE device_id = ?1", [device_id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    };
    let owner = owner?;
    let row = find_key(db, &owner)?;
    if row.device_id.as_deref() != Some(device_id) {
        return Some(owner);
    }

    let replacement: Option<(String, Option<String>)> = {
        let conn = db.lock();
        conn.query_row(
            "SELECT device_id, name FROM devices WHERE key = ?1 AND device_id <> ?2 ORDER BY bound_at LIMIT 1",
            params![owner, device_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()
        .flatten()
    };

    let conn = db.lock();
    match replacement {
        Some((id, name)) => {
            let _ = conn.execute(
                "UPDATE keys SET device_id = ?1, device_name = ?2 WHERE key = ?3",
                params![id, name.unwrap_or_default(), owner],
            );
        }
        None => {
            let _ = conn.execute(
                "UPDATE keys SET device_id = NULL, device_name = NULL, activated_at = NULL WHERE key = ?1",
                [&owner],
            );
        }
    }
    Some(owner)
}

pub fn devices_for_key(db: &Db, key: &str) -> Vec<String> {
    let conn = db.lock();
    let mut stmt = match conn.prepare("SELECT device_id FROM devices WHERE key = ?1") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([key], |r| r.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

/// Changing someone's address in the panel is the supported way to move an
/// account, so the machines follow it — otherwise the old address would keep
/// the hardware lock.
pub fn set_devices_email(db: &Db, key: &str, email: &str) -> usize {
    let conn = db.lock();
    conn.execute(
        "UPDATE devices SET email = lower(?2), updated_at = ?3 WHERE key = ?1",
        params![key, email, now_ms()],
    )
    .unwrap_or(0)
}

// ---------------------------------------------------- changing a key itself

pub fn update_key(db: &Db, key: &str, email: Option<&str>, note: Option<&str>, expires_at: Option<i64>) -> usize {
    let conn = db.lock();
    conn.execute(
        "UPDATE keys SET email = ?2, note = ?3, expires_at = ?4 WHERE key = ?1",
        params![key, email, note, expires_at],
    )
    .unwrap_or(0)
}

/// Lift the trial cap for good — for someone who paid you directly rather than
/// through the site.
pub fn set_key_paid(db: &Db, key: &str) -> usize {
    let conn = db.lock();
    conn.execute("UPDATE keys SET trial = 0 WHERE key = ?1", [key]).unwrap_or(0)
}

/// `None` hands the decision back to the plan, which is what most keys should
/// do: raising a plan then lifts every key sold on it.
pub fn set_key_device_limit(db: &Db, key: &str, limit: Option<i64>) -> usize {
    let conn = db.lock();
    conn.execute("UPDATE keys SET device_limit = ?2 WHERE key = ?1", params![key, limit]).unwrap_or(0)
}

pub fn set_key_plan(db: &Db, key: &str, plan: Option<&str>) -> usize {
    let conn = db.lock();
    conn.execute("UPDATE keys SET plan = ?2 WHERE key = ?1", params![key, plan]).unwrap_or(0)
}

pub fn block_key(db: &Db, key: &str, reason: &str) -> usize {
    let conn = db.lock();
    conn.execute(
        "UPDATE keys SET blocked = 1, block_reason = ?2, blocked_at = ?3 WHERE key = ?1",
        params![key, reason, now_ms()],
    )
    .unwrap_or(0)
}

pub fn unblock_key(db: &Db, key: &str) -> usize {
    let conn = db.lock();
    conn.execute(
        "UPDATE keys SET blocked = 0, block_reason = NULL, blocked_at = NULL WHERE key = ?1",
        [key],
    )
    .unwrap_or(0)
}

pub fn set_key_revoked(db: &Db, key: &str, revoked: bool) -> usize {
    let conn = db.lock();
    conn.execute("UPDATE keys SET revoked = ?2 WHERE key = ?1", params![key, revoked as i64]).unwrap_or(0)
}

/// The only way a customer moves to new hardware: clear the key's machine and
/// every ledger entry for it, or the old machine would stay bound and they
/// could never activate anywhere else. The trial counts stay where they are.
pub fn reset_key_devices(db: &Db, key: &str) -> (usize, usize) {
    let bound = devices_for_key(db, key);
    for id in &bound {
        clear_device_binding(db, id);
    }
    let conn = db.lock();
    let changed = conn
        .execute(
            "UPDATE keys SET device_id = NULL, device_name = NULL, activated_at = NULL WHERE key = ?1",
            [key],
        )
        .unwrap_or(0);
    (changed, bound.len())
}

pub fn delete_key(db: &Db, key: &str) -> usize {
    let conn = db.lock();
    conn.execute("DELETE FROM keys WHERE key = ?1", [key]).unwrap_or(0)
}
