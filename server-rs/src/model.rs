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
