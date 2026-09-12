//! What the import must get right, checked against a ledger shaped exactly like
//! the live one: a paid key, a trial key with a spent device, an expired key, a
//! published plan and a draft, notices for different audiences, and a usage
//! counter.

use serde_json::json;
use velox_license::{db::Db, importer};

fn sample() -> serde_json::Value {
    json!({
        "keys": {
            "VLX-AAAAA-BBBBB-CCCCC": {
                "key": "VLX-AAAAA-BBBBB-CCCCC",
                "email": "Paid@Example.com",
                "created_at": 1_700_000_000_000i64,
                "revoked": 0, "blocked": 0, "blocked_at": null, "block_reason": null,
                "device_id": "DEV-1", "device_name": "Office PC",
                "activated_at": 1_700_000_100_000i64, "last_heartbeat": 1_700_000_200_000i64,
                "expires_at": null, "note": "lifetime", "trial": 0,
                "plan": "lifetime", "device_limit": 3
            },
            "VLX-TRIAL-00000-00000": {
                "key": "VLX-TRIAL-00000-00000",
                "email": "trial@example.com",
                "created_at": 1_700_000_300_000i64,
                "revoked": 0, "blocked": 0,
                "device_id": "DEV-2", "device_name": "Laptop",
                "expires_at": 1_800_000_000_000i64, "trial": 1, "plan": null, "device_limit": null
            },
            "VLX-BLOCK-00000-00000": {
                "key": "VLX-BLOCK-00000-00000", "email": "blocked@example.com",
                "created_at": 1, "revoked": 1, "blocked": 1, "blocked_at": 2,
                "block_reason": "chargeback", "trial": 0
            }
        },
        "devices": {
            "DEV-1": { "email": "paid@example.com", "key": "VLX-AAAAA-BBBBB-CCCCC",
                       "trialDownloads": 0, "firstSeen": 10, "boundAt": 11, "updatedAt": 12 },
            "DEV-2": { "email": "trial@example.com", "key": "VLX-TRIAL-00000-00000",
                       "trialDownloads": 5, "firstSeen": 20, "boundAt": 21, "updatedAt": 22 }
        },
        "events": [
            { "id": 1, "at": 100, "type": "signup-trial", "key": "VLX-TRIAL-00000-00000", "ip": "1.2.3.4", "detail": "x" },
            { "id": 2, "at": 200, "type": "activate", "key": "VLX-AAAAA-BBBBB-CCCCC", "ip": "1.2.3.4", "detail": null }
        ],
        "settings": { "signupEnabled": true, "trialDownloads": 100, "defaultDeviceLimit": 1, "plansSeeded": true },
        "plans": [
            { "id": "monthly", "name": "1 Month", "price": "LKR 990", "period": "per month",
              "devices": 1, "features": ["Unlimited downloads"], "highlight": false, "active": true,
              "buyUrl": "", "order": 1 },
            { "id": "lifetime", "name": "Lifetime", "price": "", "period": "one time",
              "devices": 3, "features": [], "highlight": true, "active": false, "buyUrl": "", "order": 3 }
        ],
        "notices": [
            { "id": "n1", "title": "Welcome", "body": "hello", "audience": "all", "level": "info",
              "actionLabel": "", "actionUrl": "", "active": true, "created_at": 5, "updated_at": 6 },
            { "id": "n2", "title": "Upgrade", "body": "offer", "audience": "trial-exhausted", "level": "promo",
              "actionLabel": "See plans", "actionUrl": "https://example.com/#pricing", "active": false,
              "created_at": 7, "updated_at": 8 }
        ],
        "usage": { "VLX-AAAAA-BBBBB-CCCCC": { "day": "2026-09-12", "count": 4 } }
    })
}

#[test]
fn imports_every_section() {
    let db = Db::open_memory().unwrap();
    let n = importer::import_value(&db, &sample()).unwrap();

    assert_eq!(n.keys, 3, "every key is read");
    assert_eq!(n.devices, 2);
    assert_eq!(n.events, 2);
    assert_eq!(n.settings, 4);
    assert_eq!(n.plans, 2);
    assert_eq!(n.notices, 2);
    assert_eq!(n.usage, 1);

    let counts = db.counts().unwrap();
    assert_eq!(counts.keys, 3, "and every key is in the ledger");
    assert_eq!(counts.devices, 2);
    assert_eq!(counts.plans, 2);
    assert_eq!(counts.notices, 2);
}

#[test]
fn a_key_keeps_everything_that_decides_access() {
    let db = Db::open_memory().unwrap();
    importer::import_value(&db, &sample()).unwrap();
    let conn = db.lock();

    let (email, trial, plan, limit, expires): (String, i64, Option<String>, Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT email, trial, plan, device_limit, expires_at FROM keys WHERE key = 'VLX-AAAAA-BBBBB-CCCCC'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();

    assert_eq!(email, "Paid@Example.com", "the address is kept exactly as it was stored");
    assert_eq!(trial, 0, "a paid key does not become a trial");
    assert_eq!(plan.as_deref(), Some("lifetime"));
    assert_eq!(limit, Some(3), "its own device allowance survives");
    assert_eq!(expires, None, "a lifetime key has no expiry");

    // Case-insensitive lookup is how sign-up finds an existing customer.
    let found: i64 = conn
        .query_row("SELECT COUNT(*) FROM keys WHERE lower(email) = 'paid@example.com'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(found, 1, "the address is found without regard to case");

    let (revoked, blocked, reason): (i64, i64, Option<String>) = conn
        .query_row(
            "SELECT revoked, blocked, block_reason FROM keys WHERE key = 'VLX-BLOCK-00000-00000'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((revoked, blocked, reason.as_deref()), (1, 1, Some("chargeback")),
        "a revoked, blocked key stays revoked and blocked");
}

#[test]
fn a_spent_trial_stays_spent() {
    // The whole point of the device ledger: the count lives on the machine, so
    // importing must not hand anyone their free downloads back.
    let db = Db::open_memory().unwrap();
    importer::import_value(&db, &sample()).unwrap();
    let conn = db.lock();
    let spent: i64 = conn
        .query_row("SELECT trial_downloads FROM devices WHERE device_id = 'DEV-2'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(spent, 5);
}

#[test]
fn a_draft_plan_stays_a_draft() {
    let db = Db::open_memory().unwrap();
    importer::import_value(&db, &sample()).unwrap();
    let conn = db.lock();

    let (active, price, devices, features): (i64, Option<String>, i64, String) = conn
        .query_row("SELECT active, price, devices, features FROM plans WHERE id = 'lifetime'", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap();
    assert_eq!(active, 0, "an unpublished plan must not arrive published");
    assert_eq!(price, None, "and it still has no price");
    assert_eq!(devices, 3);
    assert_eq!(features, "[]", "its feature list survives as JSON");

    let (m_active, m_features): (i64, String) = conn
        .query_row("SELECT active, features FROM plans WHERE id = 'monthly'", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(m_active, 1);
    assert_eq!(m_features, r#"["Unlimited downloads"]"#);
}

#[test]
fn a_switched_off_notice_stays_off() {
    let db = Db::open_memory().unwrap();
    importer::import_value(&db, &sample()).unwrap();
    let conn = db.lock();
    let (audience, level, active): (String, String, i64) = conn
        .query_row("SELECT audience, level, active FROM notices WHERE id = 'n2'", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(audience, "trial-exhausted", "who it was aimed at survives");
    assert_eq!(level, "promo");
    assert_eq!(active, 0, "a notice the admin switched off does not come back on");
}

#[test]
fn settings_keep_their_types() {
    let db = Db::open_memory().unwrap();
    importer::import_value(&db, &sample()).unwrap();

    assert_eq!(db.setting("signupEnabled").unwrap(), Some(serde_json::json!(true)),
        "a boolean comes back a boolean, not the string \"true\"");
    assert_eq!(db.setting("trialDownloads").unwrap(), Some(serde_json::json!(100)));
    assert_eq!(db.setting("defaultDeviceLimit").unwrap(), Some(serde_json::json!(1)));
    assert_eq!(db.setting("nothing-set").unwrap(), None);
}

#[test]
fn importing_twice_changes_nothing() {
    // The rehearsal has to be repeatable: import a copy of live data, look at
    // it, import again, and still have one row per key.
    let db = Db::open_memory().unwrap();
    let first = importer::import_value(&db, &sample()).unwrap();
    let after_first = db.counts().unwrap();
    let second = importer::import_value(&db, &sample()).unwrap();
    let after_second = db.counts().unwrap();

    assert_eq!(first, second, "the same file reads the same way twice");
    assert_eq!(after_first.keys, after_second.keys, "no key is duplicated");
    assert_eq!(after_first.devices, after_second.devices);
    assert_eq!(after_first.plans, after_second.plans);
    assert_eq!(after_first.notices, after_second.notices);
    assert_eq!(after_first.usage, after_second.usage);
    assert_eq!(after_first.events, after_second.events,
        "and the audit log is not doubled by a second run");
}

#[test]
fn a_broken_file_leaves_the_ledger_untouched() {
    let db = Db::open_memory().unwrap();
    importer::import_value(&db, &sample()).unwrap();
    let before = db.counts().unwrap();

    // A plan with no id: the import must fail as a whole rather than leave the
    // ledger half-written.
    let broken = serde_json::json!({ "plans": [{ "name": "No id here" }] });
    assert!(importer::import_value(&db, &broken).is_err());

    let after = db.counts().unwrap();
    assert_eq!(before.plans, after.plans, "nothing was committed from the broken file");
    assert_eq!(before.keys, after.keys);
}

#[test]
fn an_empty_ledger_is_not_an_error() {
    let db = Db::open_memory().unwrap();
    let n = importer::import_value(&db, &serde_json::json!({})).unwrap();
    assert_eq!(n, importer::Imported::default(), "a fresh install has nothing to import, and that is fine");
}
