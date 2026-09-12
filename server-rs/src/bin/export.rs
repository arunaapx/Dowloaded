//! Writes the SQLite ledger back out as the JSON file the Node server reads.
//!
//!   cargo run --bin export -- ../server/data/licenses.db /tmp/licenses.json
//!
//! This is the rollback. Without it, going back to the Node server after the
//! cutover means going back to the JSON file as it was when the cutover
//! happened — losing every key sold, every device bound and every setting
//! changed in between. With it, a rollback costs nothing but a restart:
//!
//!   ./export data/licenses.db /tmp/licenses.json
//!   cp /tmp/licenses.json server/data/licenses.json     # after stopping it
//!   pm2 start velox-license
//!
//! It is the exact inverse of `import`, and the pair is tested by round-tripping
//! a real ledger: export(import(file)) has to be the same file, or one of them
//! is dropping something a customer paid for.

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use velox_license::db::Db;

fn main() {
    let mut args = std::env::args().skip(1);
    let sqlite = args.next().map(PathBuf::from);
    let json = args.next().map(PathBuf::from);

    let (sqlite, json) = match (sqlite, json) {
        (Some(s), Some(j)) => (s, j),
        _ => {
            eprintln!("usage: export <licenses.db> <licenses.json>");
            std::process::exit(2);
        }
    };
    if !sqlite.exists() {
        eprintln!("no such database: {}", sqlite.display());
        std::process::exit(1);
    }

    let db = match Db::open(&sqlite) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("cannot open {}: {e}", sqlite.display());
            std::process::exit(1);
        }
    };

    let state = match build(&db) {
        Ok(state) => state,
        Err(e) => {
            eprintln!("cannot read the ledger: {e}");
            std::process::exit(1);
        }
    };

    // Written through a temp file and renamed, the way the Node server writes it:
    // a half-written ledger is worse than no export at all.
    let text = serde_json::to_string_pretty(&state).unwrap_or_else(|_| "{}".into());
    let tmp = json.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, &text) {
        eprintln!("cannot write {}: {e}", tmp.display());
        std::process::exit(1);
    }
    if let Err(e) = std::fs::rename(&tmp, &json) {
        eprintln!("cannot move into place: {e}");
        std::process::exit(1);
    }

    let count = |name: &str| -> usize {
        match state.get(name) {
            Some(Value::Array(a)) => a.len(),
            Some(Value::Object(o)) => o.len(),
            _ => 0,
        }
    };
    println!("wrote {} ({} bytes)", json.display(), text.len());
    println!(
        "  keys {} · devices {} · plans {} · notices {} · settings {} · usage {} · events {}",
        count("keys"),
        count("devices"),
        count("plans"),
        count("notices"),
        count("settings"),
        count("usage"),
        count("events"),
    );
    println!();
    println!("the database is untouched; this is a copy in the shape the Node server reads");
}

fn build(db: &Db) -> rusqlite::Result<Map<String, Value>> {
    let conn = db.lock();
    let mut state = Map::new();

    // --- keys ---------------------------------------------------------------
    //
    // Keyed by the key itself, and carrying every column, because the Node
    // server's migrate() is not a substitute for a complete row: a field that
    // vanishes here is a licence that changes meaning on the way back.
    let mut keys = Map::new();
    {
        let mut stmt = conn.prepare(
            "SELECT key, email, created_at, revoked, blocked, blocked_at, block_reason, device_id,
                    device_name, activated_at, last_heartbeat, expires_at, note, trial, plan, device_limit
             FROM keys ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                json!({
                    "key": r.get::<_, String>(0)?,
                    "email": r.get::<_, Option<String>>(1)?,
                    "created_at": r.get::<_, Option<i64>>(2)?,
                    "revoked": r.get::<_, i64>(3)?,
                    "blocked": r.get::<_, i64>(4)?,
                    "blocked_at": r.get::<_, Option<i64>>(5)?,
                    "block_reason": r.get::<_, Option<String>>(6)?,
                    "device_id": r.get::<_, Option<String>>(7)?,
                    "device_name": r.get::<_, Option<String>>(8)?,
                    "activated_at": r.get::<_, Option<i64>>(9)?,
                    "last_heartbeat": r.get::<_, Option<i64>>(10)?,
                    "expires_at": r.get::<_, Option<i64>>(11)?,
                    "note": r.get::<_, Option<String>>(12)?,
                    "trial": r.get::<_, i64>(13)?,
                    "plan": r.get::<_, Option<String>>(14)?,
                    "device_limit": r.get::<_, Option<i64>>(15)?,
                }),
            ))
        })?;
        for row in rows.flatten() {
            keys.insert(row.0, row.1);
        }
    }
    state.insert("keys".into(), Value::Object(keys));

    // --- devices ------------------------------------------------------------
    //
    // camelCase here: this is the JSON store's own spelling, and the Node server
    // reads these names.
    let mut devices = Map::new();
    {
        let mut stmt = conn.prepare(
            "SELECT device_id, email, key, name, trial_downloads, first_seen, bound_at, updated_at
             FROM devices ORDER BY first_seen",
        )?;
        let rows = stmt.query_map([], |r| {
            let mut row = Map::new();
            let id: String = r.get(0)?;
            // Only what is there: the Node store deletes a field rather than
            // nulling it, and an unbound machine with key:null would read as
            // bound to nothing rather than not bound.
            if let Some(email) = r.get::<_, Option<String>>(1)? {
                row.insert("email".into(), json!(email));
            }
            if let Some(key) = r.get::<_, Option<String>>(2)? {
                row.insert("key".into(), json!(key));
            }
            if let Some(name) = r.get::<_, Option<String>>(3)? {
                row.insert("name".into(), json!(name));
            }
            row.insert("trialDownloads".into(), json!(r.get::<_, i64>(4)?));
            if let Some(seen) = r.get::<_, Option<i64>>(5)? {
                row.insert("firstSeen".into(), json!(seen));
            }
            if let Some(bound) = r.get::<_, Option<i64>>(6)? {
                row.insert("boundAt".into(), json!(bound));
            }
            if let Some(updated) = r.get::<_, Option<i64>>(7)? {
                row.insert("updatedAt".into(), json!(updated));
            }
            Ok((id, Value::Object(row)))
        })?;
        for row in rows.flatten() {
            devices.insert(row.0, row.1);
        }
    }
    state.insert("devices".into(), Value::Object(devices));

    // --- events -------------------------------------------------------------
    //
    // Oldest first and numbered from one, which is what the Node store's array
    // position means. It keeps the last thousand; so does this.
    let mut events: Vec<Value> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT at, type, key, ip, detail FROM events ORDER BY at DESC, id DESC LIMIT 1000",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(json!({
                "at": r.get::<_, Option<i64>>(0)?,
                "type": r.get::<_, Option<String>>(1)?,
                "key": r.get::<_, Option<String>>(2)?,
                "ip": r.get::<_, Option<String>>(3)?,
                "detail": r.get::<_, Option<String>>(4)?,
            }))
        })?;
        events.extend(rows.flatten());
    }
    events.reverse();
    for (i, event) in events.iter_mut().enumerate() {
        if let Some(map) = event.as_object_mut() {
            map.insert("id".into(), json!(i + 1));
        }
    }
    state.insert("events".into(), Value::Array(events));

    // --- settings -----------------------------------------------------------
    //
    // Stored as JSON, so a boolean comes back a boolean and a number a number.
    let mut settings = Map::new();
    {
        let mut stmt = conn.prepare("SELECT name, value FROM settings ORDER BY name")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for (name, raw) in rows.flatten() {
            settings.insert(name, serde_json::from_str(&raw).unwrap_or(Value::Null));
        }
    }
    state.insert("settings".into(), Value::Object(settings));

    // --- plans --------------------------------------------------------------
    let mut plans: Vec<Value> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, name, price, period, devices, features, highlight, active, buy_url, ord
             FROM plans ORDER BY ord, name",
        )?;
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
        })?;
        plans.extend(rows.flatten());
    }
    state.insert("plans".into(), Value::Array(plans));

    // --- notices ------------------------------------------------------------
    let mut notices: Vec<Value> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, body, audience, level, action_label, action_url, active, created_at, updated_at
             FROM notices ORDER BY created_at DESC",
        )?;
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
        })?;
        notices.extend(rows.flatten());
    }
    state.insert("notices".into(), Value::Array(notices));

    // --- usage --------------------------------------------------------------
    //
    // The JSON store keeps only today, keyed by the key. The database keeps the
    // history; today is what the Node server can use.
    let today: Option<String> = conn
        .query_row("SELECT day FROM usage ORDER BY day DESC LIMIT 1", [], |r| r.get(0))
        .optional()?;
    let mut usage = Map::new();
    if let Some(day) = today {
        let mut stmt = conn.prepare("SELECT key, count FROM usage WHERE day = ?1")?;
        let rows = stmt.query_map([&day], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for (key, count) in rows.flatten() {
            usage.insert(key, json!({ "day": day, "count": count }));
        }
    }
    state.insert("usage".into(), Value::Object(usage));

    Ok(state)
}
