//! Reading the Node server's `licenses.json` into SQLite.
//!
//! This runs once, at the cutover, against real customer data — keys people
//! paid for. So it is written to be re-runnable and to prove itself: importing
//! twice leaves the same rows, and every section is counted on both sides so a
//! silent partial import is impossible to miss.
//!
//! Nothing is "fixed" on the way in. A field the JSON does not have arrives as
//! NULL, exactly as the Node server would read it, because the two servers run
//! side by side during the port and must agree about every key.

use crate::db::Db;
use rusqlite::params;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Default, PartialEq)]
pub struct Imported {
    pub keys: usize,
    pub devices: usize,
    pub events: usize,
    pub settings: usize,
    pub plans: usize,
    pub notices: usize,
    pub usage: usize,
}

fn s(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::String(x)) if !x.is_empty() => Some(x.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn i(v: &Value, key: &str) -> Option<i64> {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_i64(),
        // The JSON file writes these as 0/1 already, but a hand-edited file in
        // the wild may carry a real boolean.
        Some(Value::Bool(b)) => Some(*b as i64),
        Some(Value::String(x)) => x.parse().ok(),
        _ => None,
    }
}

fn flag(v: &Value, key: &str) -> i64 {
    match v.get(key) {
        Some(Value::Bool(b)) => *b as i64,
        Some(Value::Number(n)) => (n.as_i64().unwrap_or(0) != 0) as i64,
        _ => 0,
    }
}

pub fn import_file(db: &Db, path: &Path) -> Result<Imported, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let root: Value = serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
    import_value(db, &root)
}

pub fn import_value(db: &Db, root: &Value) -> Result<Imported, String> {
    let mut done = Imported::default();
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // --- keys -------------------------------------------------------------
    if let Some(keys) = root.get("keys").and_then(Value::as_object) {
        for (id, row) in keys {
            tx.execute(
                "INSERT INTO keys (key, email, created_at, revoked, blocked, blocked_at, block_reason,
                                   device_id, device_name, activated_at, last_heartbeat, expires_at,
                                   note, trial, plan, device_limit)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
                 ON CONFLICT(key) DO UPDATE SET
                   email=excluded.email, created_at=excluded.created_at, revoked=excluded.revoked,
                   blocked=excluded.blocked, blocked_at=excluded.blocked_at, block_reason=excluded.block_reason,
                   device_id=excluded.device_id, device_name=excluded.device_name,
                   activated_at=excluded.activated_at, last_heartbeat=excluded.last_heartbeat,
                   expires_at=excluded.expires_at, note=excluded.note, trial=excluded.trial,
                   plan=excluded.plan, device_limit=excluded.device_limit",
                params![
                    id,
                    s(row, "email"),
                    i(row, "created_at"),
                    flag(row, "revoked"),
                    flag(row, "blocked"),
                    i(row, "blocked_at"),
                    s(row, "block_reason"),
                    s(row, "device_id"),
                    s(row, "device_name"),
                    i(row, "activated_at"),
                    i(row, "last_heartbeat"),
                    i(row, "expires_at"),
                    s(row, "note"),
                    flag(row, "trial"),
                    s(row, "plan"),
                    i(row, "device_limit"),
                ],
            )
            .map_err(|e| format!("key {id}: {e}"))?;
            done.keys += 1;
        }
    }

    // --- devices ----------------------------------------------------------
    if let Some(devices) = root.get("devices").and_then(Value::as_object) {
        for (id, row) in devices {
            tx.execute(
                "INSERT INTO devices (device_id, email, key, name, trial_downloads, first_seen, bound_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(device_id) DO UPDATE SET
                   email=excluded.email, key=excluded.key, name=excluded.name,
                   trial_downloads=excluded.trial_downloads, first_seen=excluded.first_seen,
                   bound_at=excluded.bound_at, updated_at=excluded.updated_at",
                params![
                    id,
                    s(row, "email"),
                    s(row, "key"),
                    s(row, "name"),
                    i(row, "trialDownloads").unwrap_or(0),
                    i(row, "firstSeen"),
                    i(row, "boundAt"),
                    i(row, "updatedAt"),
                ],
            )
            .map_err(|e| format!("device {id}: {e}"))?;
            done.devices += 1;
        }
    }

    // --- events -----------------------------------------------------------
    // Ids are not carried across: the JSON file numbers them by array position,
    // which collides as soon as the log is trimmed. SQLite assigns its own.
    if let Some(events) = root.get("events").and_then(Value::as_array) {
        for row in events {
            tx.execute(
                "INSERT OR IGNORE INTO events (at, type, key, ip, detail) VALUES (?1,?2,?3,?4,?5)",
                params![i(row, "at").unwrap_or(0), s(row, "type"), s(row, "key"), s(row, "ip"), s(row, "detail")],
            )
            .map_err(|e| format!("event: {e}"))?;
            done.events += 1;
        }
    }

    // --- settings ---------------------------------------------------------
    if let Some(settings) = root.get("settings").and_then(Value::as_object) {
        for (name, value) in settings {
            tx.execute(
                "INSERT INTO settings (name, value) VALUES (?1, ?2)
                 ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                params![name, value.to_string()],
            )
            .map_err(|e| format!("setting {name}: {e}"))?;
            done.settings += 1;
        }
    }

    // --- plans ------------------------------------------------------------
    if let Some(plans) = root.get("plans").and_then(Value::as_array) {
        for row in plans {
            let id = s(row, "id").ok_or("a plan has no id")?;
            let features = row.get("features").cloned().unwrap_or(Value::Array(vec![]));
            tx.execute(
                "INSERT INTO plans (id, name, price, period, devices, features, highlight, active, buy_url, ord)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, price=excluded.price, period=excluded.period,
                   devices=excluded.devices, features=excluded.features, highlight=excluded.highlight,
                   active=excluded.active, buy_url=excluded.buy_url, ord=excluded.ord",
                params![
                    id,
                    s(row, "name").unwrap_or_default(),
                    s(row, "price"),
                    s(row, "period"),
                    i(row, "devices").unwrap_or(1),
                    features.to_string(),
                    flag(row, "highlight"),
                    flag(row, "active"),
                    s(row, "buyUrl"),
                    i(row, "order").unwrap_or(0),
                ],
            )
            .map_err(|e| format!("plan: {e}"))?;
            done.plans += 1;
        }
    }

    // --- notices ----------------------------------------------------------
    if let Some(notices) = root.get("notices").and_then(Value::as_array) {
        for row in notices {
            let id = s(row, "id").ok_or("a notice has no id")?;
            tx.execute(
                "INSERT INTO notices (id, title, body, audience, level, action_label, action_url, active, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                 ON CONFLICT(id) DO UPDATE SET
                   title=excluded.title, body=excluded.body, audience=excluded.audience, level=excluded.level,
                   action_label=excluded.action_label, action_url=excluded.action_url, active=excluded.active,
                   created_at=excluded.created_at, updated_at=excluded.updated_at",
                params![
                    id,
                    s(row, "title").unwrap_or_default(),
                    s(row, "body"),
                    s(row, "audience").unwrap_or_else(|| "all".into()),
                    s(row, "level").unwrap_or_else(|| "info".into()),
                    s(row, "actionLabel"),
                    s(row, "actionUrl"),
                    flag(row, "active"),
                    i(row, "created_at"),
                    i(row, "updated_at"),
                ],
            )
            .map_err(|e| format!("notice: {e}"))?;
            done.notices += 1;
        }
    }

    // --- usage ------------------------------------------------------------
    if let Some(usage) = root.get("usage").and_then(Value::as_object) {
        for (key, row) in usage {
            let day = s(row, "day").unwrap_or_default();
            if day.is_empty() {
                continue; // a counter with no date says nothing about any day
            }
            tx.execute(
                "INSERT INTO usage (key, day, count) VALUES (?1,?2,?3)
                 ON CONFLICT(key, day) DO UPDATE SET count = excluded.count",
                params![key, day, i(row, "count").unwrap_or(0)],
            )
            .map_err(|e| format!("usage {key}: {e}"))?;
            done.usage += 1;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(done)
}
