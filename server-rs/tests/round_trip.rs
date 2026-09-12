//! In, and back out again.
//!
//! The importer is the cutover and the exporter is the rollback, so the pair has
//! to be lossless: whatever went into SQLite has to come back out in the shape
//! the Node server reads. A field dropped here is a licence that changes meaning
//! on the way back — a paid key that returns as a trial, a machine that returns
//! unbound, a price that returns unpublished.
//!
//! These compare the JSON that comes out against the JSON that went in, field by
//! field, rather than checking that each piece "looks right".

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use velox_license::{db::Db, importer};

/// A directory of its own per test. These run in parallel and now_ms() hands
/// several of them the same millisecond, so one was deleting another's ledger.
fn scratch(what: &str) -> std::path::PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("velox-{what}-{}-{}-{n}", std::process::id(), velox_license::model::now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A ledger with one of everything that matters, including the awkward cases:
/// a key on a plan, a key with its own allowance, an unbound machine, a spent
/// trial, a draft plan, a switched-off notice.
fn ledger() -> Value {
    json!({
        "keys": {
            "VLX-PAID-00000-00000": {
                "key": "VLX-PAID-00000-00000", "email": "paid@example.com", "created_at": 1_700_000_000_000i64,
                "revoked": 0, "blocked": 0, "blocked_at": null, "block_reason": null,
                "device_id": "DEV-P", "device_name": "The PC", "activated_at": 1_700_000_100_000i64,
                "last_heartbeat": 1_700_000_200_000i64, "expires_at": 1_900_000_000_000i64,
                "note": "paid by transfer", "trial": 0, "plan": "yearly", "device_limit": 4
            },
            "VLX-TRIAL-0000-00000": {
                "key": "VLX-TRIAL-0000-00000", "email": "trial@example.com", "created_at": 1_700_000_300_000i64,
                "revoked": 0, "blocked": 0, "blocked_at": null, "block_reason": null,
                "device_id": "DEV-T", "device_name": "Laptop", "activated_at": 1_700_000_400_000i64,
                "last_heartbeat": null, "expires_at": null,
                "note": null, "trial": 1, "plan": null, "device_limit": null
            },
            "VLX-STOP-00000-00000": {
                "key": "VLX-STOP-00000-00000", "email": "stop@example.com", "created_at": 1_700_000_500_000i64,
                "revoked": 1, "blocked": 1, "blocked_at": 1_700_000_600_000i64, "block_reason": "chargeback",
                "device_id": null, "device_name": null, "activated_at": null,
                "last_heartbeat": null, "expires_at": 1_700_000_000_000i64,
                "note": null, "trial": 0, "plan": null, "device_limit": null
            }
        },
        "devices": {
            "DEV-P": { "email": "paid@example.com", "key": "VLX-PAID-00000-00000", "name": "The PC",
                       "trialDownloads": 0, "firstSeen": 1_700_000_100_000i64,
                       "boundAt": 1_700_000_100_000i64, "updatedAt": 1_700_000_200_000i64 },
            "DEV-T": { "email": "trial@example.com", "key": "VLX-TRIAL-0000-00000", "name": "Laptop",
                       "trialDownloads": 5, "firstSeen": 1_700_000_400_000i64,
                       "boundAt": 1_700_000_400_000i64, "updatedAt": 1_700_000_450_000i64 },
            // A machine nobody owns: unbound by an admin, keeping its trial count.
            "DEV-FREE": { "trialDownloads": 3, "firstSeen": 1_700_000_700_000i64, "updatedAt": 1_700_000_800_000i64 }
        },
        "events": [
            { "id": 1, "at": 1_700_000_100_000i64, "type": "activate", "key": "VLX-PAID-00000-00000",
              "ip": "1.1.1.1", "detail": "The PC" },
            { "id": 2, "at": 1_700_000_200_000i64, "type": "authorize", "key": "VLX-PAID-00000-00000",
              "ip": "1.1.1.1", "detail": "paid" },
            { "id": 3, "at": 1_700_000_300_000i64, "type": "admin-login", "key": null,
              "ip": "2.2.2.2", "detail": "admin" }
        ],
        "settings": {
            "signupEnabled": true, "trialDownloads": 100, "defaultLicenseDays": 3,
            "signupPerHour": 0, "plansSeeded": true, "defaultDeviceLimit": 1
        },
        "plans": [
            { "id": "monthly", "name": "1 Month", "price": "LKR 999", "period": "per month", "devices": 1,
              "features": ["Unlimited downloads"], "highlight": false, "active": true, "buyUrl": "", "order": 1 },
            { "id": "yearly", "name": "1 Year", "price": "LKR 7999", "period": "per year", "devices": 2,
              "features": ["Unlimited downloads", "Two months free"], "highlight": true, "active": true,
              "buyUrl": "https://example.com/buy", "order": 2 },
            { "id": "draft", "name": "Not finished", "price": "", "period": "one time", "devices": 3,
              "features": [], "highlight": false, "active": false, "buyUrl": "", "order": 3 }
        ],
        "notices": [
            { "id": "welcome", "title": "Welcome", "body": "Thanks for installing.", "audience": "all",
              "level": "info", "actionLabel": "", "actionUrl": "", "active": true,
              "created_at": 1_700_000_900_000i64, "updated_at": 1_700_000_900_000i64 },
            { "id": "offer", "title": "Half price", "body": "", "audience": "trial-exhausted",
              "level": "promo", "actionLabel": "See plans", "actionUrl": "https://example.com/#pricing",
              "active": false, "created_at": 1_700_001_000_000i64, "updated_at": 1_700_001_100_000i64 }
        ],
        "usage": {
            "VLX-PAID-00000-00000": { "day": "2026-09-13", "count": 7 },
            "VLX-TRIAL-0000-00000": { "day": "2026-09-13", "count": 2 }
        }
    })
}

/// Runs both tools the way the cutover and the rollback run them, through files.
fn round_trip(source: &Value) -> Value {
    let dir = scratch("round-trip");
    let json_in = dir.join("in.json");
    let db_path = dir.join("licenses.db");
    let json_out = dir.join("out.json");
    std::fs::write(&json_in, serde_json::to_string_pretty(source).unwrap()).unwrap();

    let db = Db::open(&db_path).unwrap();
    importer::import_value(&db, source).expect("the ledger imports");
    drop(db);

    // The exporter is a separate binary, so it is run as one — the rollback runs
    // it from a shell, and a test that skips that misses the plumbing.
    let exe = env!("CARGO_BIN_EXE_export");
    let out = std::process::Command::new(exe)
        .arg(&db_path)
        .arg(&json_out)
        .output()
        .expect("the exporter runs");
    assert!(
        out.status.success(),
        "export failed: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let text = std::fs::read_to_string(&json_out).expect("the exporter wrote a file");
    let value: Value = serde_json::from_str(&text).expect("and it is JSON");
    let _ = std::fs::remove_dir_all(&dir);
    value
}

/// A list of things with ids, as a map from id to thing.
fn by_id(value: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for row in value.as_array().cloned().unwrap_or_default() {
        let id = row["id"].as_str().unwrap_or("(no id)").to_string();
        out.insert(id, row);
    }
    Value::Object(out)
}

/// Every difference between two JSON values, by path.
fn differences(a: &Value, b: &Value, trail: &str) -> Vec<String> {
    let mut out = Vec::new();
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let mut names: Vec<&String> = x.keys().chain(y.keys()).collect();
            names.sort();
            names.dedup();
            for name in names {
                let here = if trail.is_empty() { name.clone() } else { format!("{trail}.{name}") };
                let missing = Value::Null;
                out.extend(differences(
                    x.get(name).unwrap_or(&missing),
                    y.get(name).unwrap_or(&missing),
                    &here,
                ));
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (l, r)) in x.iter().zip(y.iter()).enumerate() {
                out.extend(differences(l, r, &format!("{trail}[{i}]")));
            }
        }
        _ if a == b => {}
        _ => out.push(format!("{trail}: in {a} out {b}")),
    }
    out
}

#[test]
fn what_goes_in_comes_back_out() {
    let source = ledger();
    let back = round_trip(&source);

    // Compared section by section, so a failure says which half of the pair is
    // dropping something.
    for section in ["keys", "devices", "settings", "usage"] {
        let problems = differences(&source[section], &back[section], section);
        assert!(problems.is_empty(), "{section} changed on the way through:\n  {}", problems.join("\n  "));
    }

    // Plans and notices are lists in the file but a store keyed by id: the panel
    // sorts them itself, and the order in the file only records the order somebody
    // wrote them in. Compared by id, so a reordering is not reported as loss —
    // while anything actually missing still cannot hide.
    for section in ["plans", "notices"] {
        let problems = differences(&by_id(&source[section]), &by_id(&back[section]), section);
        assert!(problems.is_empty(), "{section} changed on the way through:\n  {}", problems.join("\n  "));
    }
}

#[test]
fn the_audit_log_comes_back_oldest_first_and_renumbered() {
    let source = ledger();
    let back = round_trip(&source);
    let events = back["events"].as_array().expect("events");
    assert_eq!(events.len(), 3);

    // The JSON store numbers events by array position and appends, so the file is
    // oldest first. Getting this backwards would show the panel an audit log in
    // reverse.
    let times: Vec<i64> = events.iter().map(|e| e["at"].as_i64().unwrap_or(0)).collect();
    assert!(times.windows(2).all(|w| w[0] <= w[1]), "{times:?}");
    let ids: Vec<i64> = events.iter().map(|e| e["id"].as_i64().unwrap_or(0)).collect();
    assert_eq!(ids, vec![1, 2, 3]);
    assert_eq!(events[0]["type"], json!("activate"));
    assert_eq!(events[2]["key"], Value::Null, "an admin event belongs to no key");
}

#[test]
fn a_machine_nobody_owns_comes_back_unowned() {
    let back = round_trip(&ledger());
    let free = &back["devices"]["DEV-FREE"];
    // Absent, not null: the Node store deletes these fields when an admin unbinds
    // a machine, and `key: null` would read as bound to a key called nothing.
    assert!(free.get("key").is_none(), "{free}");
    assert!(free.get("email").is_none(), "{free}");
    assert_eq!(free["trialDownloads"], json!(3), "and the trial count is kept: {free}");
}

#[test]
fn the_rollback_survives_what_happened_while_rust_was_live() {
    // The case the exporter exists for: keys sold, machines bound and settings
    // changed after the cutover have to come back to the Node server.
    let dir = scratch("rollback");
    let db_path = dir.join("licenses.db");
    let db = Db::open(&db_path).unwrap();
    importer::import_value(&db, &ledger()).unwrap();

    // A sale, an activation and an edit — the day's work.
    velox_license::model::insert_key(&db, "VLX-NEW00-00000-00000", Some("buyer@example.com"), "purchase", Some(1_950_000_000_000), false).unwrap();
    let fresh = velox_license::model::find_key(&db, "VLX-NEW00-00000-00000").unwrap();
    velox_license::model::bind_device(&db, &fresh, "DEV-NEW", "Buyer PC");
    db.set_setting("trialDownloads", &json!(50)).unwrap();
    drop(db);

    let json_out = dir.join("out.json");
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_export"))
        .arg(&db_path)
        .arg(&json_out)
        .output()
        .unwrap();
    assert!(out.status.success());
    let back: Value = serde_json::from_str(&std::fs::read_to_string(&json_out).unwrap()).unwrap();

    let sold = &back["keys"]["VLX-NEW00-00000-00000"];
    assert_eq!(sold["email"], json!("buyer@example.com"), "the sale is in the file: {sold}");
    assert_eq!(sold["trial"], json!(0), "and it is a paid key, not a trial");
    assert_eq!(sold["device_id"], json!("DEV-NEW"));
    assert_eq!(back["devices"]["DEV-NEW"]["key"], json!("VLX-NEW00-00000-00000"));
    assert_eq!(back["settings"]["trialDownloads"], json!(50), "and the edit came back too");
    assert_eq!(
        back["keys"]["VLX-PAID-00000-00000"]["note"],
        json!("paid by transfer"),
        "without disturbing what was already there"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn importing_what_was_exported_changes_nothing() {
    // The full circle, which is what a rollback and a second cutover would do:
    // file → database → file → database, and the two databases agree.
    let source = ledger();
    let once = round_trip(&source);
    let twice = round_trip(&once);
    let problems = differences(&once, &twice, "");
    assert!(problems.is_empty(), "a second trip changed things:\n  {}", problems.join("\n  "));
}

#[test]
fn an_empty_ledger_round_trips_as_an_empty_one() {
    // A fresh install, exported before anyone has bought anything. It has to be a
    // file the Node server can read, not an error and not "{}".
    let back = round_trip(&json!({}));
    for section in ["keys", "devices", "settings", "usage"] {
        assert!(back[section].is_object(), "{section} should be an empty object: {back}");
    }
    for section in ["events", "plans", "notices"] {
        assert!(back[section].is_array(), "{section} should be an empty list: {back}");
    }
    assert!(back["keys"].as_object().unwrap().is_empty());
}

#[test]
fn the_exporter_says_what_it_cannot_do() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_export")).output().unwrap();
    assert!(!out.status.success(), "no arguments is not success");
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage:"));

    let out = std::process::Command::new(env!("CARGO_BIN_EXE_export"))
        .arg("/no/such/ledger.db")
        .arg(std::env::temp_dir().join("never-written.json"))
        .output()
        .unwrap();
    assert!(!out.status.success(), "a missing database is not success");
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(said.contains("no such database"), "{said}");
}
