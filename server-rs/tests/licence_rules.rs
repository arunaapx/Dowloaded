//! The rules that decide whether someone may download.
//!
//! These test the decisions, not the HTTP around them: what state a key is in,
//! how many machines it covers, what a trial has left, which notice reaches
//! whom, and which plans a customer may see. If one of these is wrong, someone
//! either pays for nothing or gets everything for free.

use serde_json::json;
use velox_license::{db::Db, importer, model};

fn ledger() -> Db {
    let db = Db::open_memory().unwrap();
    importer::import_value(
        &db,
        &json!({
            "keys": {
                "VLX-PAID-00000-00000": { "email": "paid@example.com", "trial": 0, "plan": "lifetime" },
                "VLX-TRIAL-0000-00000": { "email": "trial@example.com", "trial": 1, "device_id": "DEV-T" },
                "VLX-GONE-00000-00000": { "email": "gone@example.com", "trial": 0, "expires_at": 1_000 },
                "VLX-STOP-00000-00000": { "email": "stop@example.com", "trial": 0, "revoked": 1 },
                "VLX-HOLD-00000-00000": { "email": "hold@example.com", "trial": 0, "blocked": 1 },
                "VLX-NEW-000000-00000": { "email": "new@example.com", "trial": 0 }
            },
            "devices": {
                "DEV-T": { "email": "trial@example.com", "key": "VLX-TRIAL-0000-00000", "trialDownloads": 0 }
            },
            "plans": [
                { "id": "lifetime", "name": "Lifetime", "price": "LKR 6999", "period": "one time",
                  "devices": 3, "features": ["Pay once"], "active": true, "highlight": true, "order": 1 },
                { "id": "monthly", "name": "1 Month", "price": "LKR 999", "period": "per month",
                  "devices": 1, "features": [], "active": true, "order": 2 },
                { "id": "draft", "name": "Not finished", "price": "", "period": "per year",
                  "devices": 2, "features": [], "active": false, "order": 3 }
            ],
            "notices": [
                { "id": "everyone", "title": "For everyone", "audience": "all", "active": true, "created_at": 5 },
                { "id": "paidonly", "title": "For subscribers", "audience": "paid", "active": true, "created_at": 4 },
                { "id": "trialonly", "title": "For trials", "audience": "trial", "active": true, "created_at": 3 },
                { "id": "spent", "title": "Your free downloads are gone", "audience": "trial-exhausted", "active": true, "created_at": 2 },
                { "id": "lapsed", "title": "Come back", "audience": "expired", "active": true, "created_at": 1 },
                { "id": "off", "title": "Switched off", "audience": "all", "active": false, "created_at": 0 }
            ]
        }),
    )
    .unwrap();
    db
}

fn key(db: &Db, id: &str) -> model::Key {
    model::find_key(db, id).expect("key is in the ledger")
}

#[test]
fn a_key_is_in_exactly_one_state() {
    let db = ledger();
    assert_eq!(model::state_of(&key(&db, "VLX-TRIAL-0000-00000")), model::State::Active,
        "a key bound to a machine is active");
    assert_eq!(model::state_of(&key(&db, "VLX-NEW-000000-00000")), model::State::Pending,
        "issued but never used is pending, not active");
    assert_eq!(model::state_of(&key(&db, "VLX-GONE-00000-00000")), model::State::Expired);
    assert_eq!(model::state_of(&key(&db, "VLX-STOP-00000-00000")), model::State::Revoked);
    assert_eq!(model::state_of(&key(&db, "VLX-HOLD-00000-00000")), model::State::Blocked);
}

#[test]
fn revoked_outranks_expired() {
    // A key an admin took away stays taken away, whatever its dates say —
    // otherwise a refund case would quietly read as a lapsed subscription.
    let db = ledger();
    let mut row = key(&db, "VLX-STOP-00000-00000");
    row.expires_at = Some(1_000);
    assert_eq!(model::state_of(&row), model::State::Revoked);
}

#[test]
fn the_device_allowance_has_an_order_of_precedence() {
    let db = ledger();
    let paid = key(&db, "VLX-PAID-00000-00000");

    assert_eq!(model::device_limit(&db, &paid, 1), 3, "its plan allows three machines");

    let mut pinned = paid.clone();
    pinned.device_limit = Some(1);
    assert_eq!(model::device_limit(&db, &pinned, 1), 1, "a number set on the key wins over the plan");

    let plainless = key(&db, "VLX-NEW-000000-00000");
    assert_eq!(model::device_limit(&db, &plainless, 2), 2, "a key with no plan falls back to the default");
}

#[test]
fn a_machine_already_on_the_key_is_not_a_new_machine() {
    // This is the reinstall case: the app forgets its licence, asks again, and
    // must not be counted as a second PC.
    let db = ledger();
    let row = key(&db, "VLX-NEW-000000-00000");
    model::bind_device(&db, &row, "BOARD-1", "Office PC");

    let row = key(&db, "VLX-NEW-000000-00000");
    let again = model::device_allowed(&db, &row, "BOARD-1", 1);
    assert!(again.allowed && again.known, "the same machine is recognised, not counted again");
    assert_eq!(again.used, 1);

    let other = model::device_allowed(&db, &row, "BOARD-2", 1);
    assert!(!other.allowed, "a different machine is refused once the allowance is spent");
    assert_eq!(
        model::device_limit_message(&other),
        "This key is already connected with another device. Contact support to move it.",
        "one machine reads as the rule customers already know"
    );
}

#[test]
fn a_bigger_allowance_says_where_you_stand() {
    let db = ledger();
    for id in ["PC-1", "PC-2", "PC-3"] {
        // Re-read each time: binding changes the row, and the count has to come
        // from the ledger rather than from a copy taken before.
        let row = key(&db, "VLX-PAID-00000-00000");
        model::bind_device(&db, &row, id, id);
    }
    let row = key(&db, "VLX-PAID-00000-00000");
    let fourth = model::device_allowed(&db, &row, "PC-4", 1);
    assert!(!fourth.allowed);
    assert_eq!(fourth.used, 3);
    assert_eq!(fourth.limit, 3);
    assert!(model::device_limit_message(&fourth).contains("3 of 3 devices"));
}

#[test]
fn raising_a_plan_lifts_every_key_sold_on_it() {
    let db = ledger();
    let row = key(&db, "VLX-PAID-00000-00000");
    assert_eq!(model::device_limit(&db, &row, 1), 3);
    {
        let conn = db.lock();
        conn.execute("UPDATE plans SET devices = 5 WHERE id = 'lifetime'", []).unwrap();
    }
    assert_eq!(model::device_limit(&db, &row, 1), 5, "no key had to be edited");
}

#[test]
fn a_trial_is_counted_on_the_machine_not_the_key() {
    let db = ledger();
    let row = key(&db, "VLX-TRIAL-0000-00000");
    assert_eq!(model::trial_remaining(&db, &row, 3), Some(3));

    model::spend_trial_download(&db, "DEV-T");
    model::spend_trial_download(&db, "DEV-T");
    assert_eq!(model::trial_remaining(&db, &row, 3), Some(1));

    model::spend_trial_download(&db, "DEV-T");
    model::spend_trial_download(&db, "DEV-T");
    assert_eq!(model::trial_remaining(&db, &row, 3), Some(0), "it stops at nothing left, never below");

    let paid = key(&db, "VLX-PAID-00000-00000");
    assert_eq!(model::trial_remaining(&db, &paid, 3), None, "a paid key has no trial to count");
}

#[test]
fn a_notice_reaches_only_who_it_was_aimed_at() {
    let db = ledger();
    let trial = key(&db, "VLX-TRIAL-0000-00000");
    let paid = key(&db, "VLX-PAID-00000-00000");
    let gone = key(&db, "VLX-GONE-00000-00000");

    let titles = |k: &model::Key, left: Option<i64>| -> Vec<String> {
        model::notices_for(&db, k, left)
            .iter()
            .map(|n| n["title"].as_str().unwrap_or_default().to_string())
            .collect()
    };

    let for_trial = titles(&trial, Some(3));
    assert!(for_trial.contains(&"For everyone".to_string()));
    assert!(for_trial.contains(&"For trials".to_string()));
    assert!(!for_trial.contains(&"For subscribers".to_string()), "a trial user is not a subscriber");
    assert!(!for_trial.contains(&"Your free downloads are gone".to_string()),
        "the offer waits until the downloads are actually gone");
    assert!(!for_trial.iter().any(|t| t == "Switched off"), "a notice switched off reaches nobody");

    let spent = titles(&trial, Some(0));
    assert!(spent.contains(&"Your free downloads are gone".to_string()),
        "and appears exactly when they are");

    let for_paid = titles(&paid, None);
    assert!(for_paid.contains(&"For subscribers".to_string()));
    assert!(!for_paid.contains(&"For trials".to_string()));

    let for_lapsed = titles(&gone, None);
    assert!(for_lapsed.contains(&"Come back".to_string()), "an expired licence is worth writing to");
    assert!(!for_lapsed.contains(&"For subscribers".to_string()), "but is not a current subscriber");
}

#[test]
fn only_finished_plans_reach_a_customer() {
    let db = ledger();
    let plans = model::public_plans(&db);
    let ids: Vec<&str> = plans.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["lifetime", "monthly"], "the unpriced draft is not published");
    assert_eq!(plans[0].devices, 3);
    assert!(plans[0].highlight, "the tier marked most popular says so");
    assert_eq!(plans[0].features, vec!["Pay once".to_string()]);

    // A price with nothing in it is not a price.
    {
        let conn = db.lock();
        conn.execute("UPDATE plans SET price = '   ' WHERE id = 'monthly'", []).unwrap();
    }
    assert_eq!(model::public_plans(&db).len(), 1, "blank spaces do not count as a price");
}

#[test]
fn the_profile_is_what_the_account_screen_shows() {
    let db = ledger();
    let row = key(&db, "VLX-PAID-00000-00000");
    model::bind_device(&db, &row, "PC-1", "Office");
    model::bump_usage(&db, &row.key);
    model::bump_usage(&db, &row.key);

    let row = key(&db, "VLX-PAID-00000-00000");
    let profile = model::public_profile(&db, &row, 5, 1);
    assert_eq!(profile["status"], "active");
    assert_eq!(profile["trial"], false);
    assert_eq!(profile["plan"]["name"], "Lifetime");
    assert_eq!(profile["downloadsToday"], 2, "today's downloads are counted");
    assert_eq!(profile["devices"]["used"], 1);
    assert_eq!(profile["devices"]["limit"], 3);
    assert_eq!(profile["trialRemaining"], serde_json::Value::Null);

    let trial = key(&db, "VLX-TRIAL-0000-00000");
    let trial_profile = model::public_profile(&db, &trial, 5, 1);
    assert_eq!(trial_profile["plan"]["name"], "Free trial", "a trial is named as the trial it is");
    assert_eq!(trial_profile["trialTotal"], 5);
}

#[test]
fn a_key_reads_the_same_however_it_is_typed() {
    assert_eq!(model::normalize_key(" vlx-abcde-fghij-klmno "), "VLX-ABCDE-FGHIJ-KLMNO");
    assert_eq!(model::normalize_key("VLX ABCDE FGHIJ KLMNO"), "VLXABCDEFGHIJKLMNO");
}

#[test]
fn a_new_key_is_hard_to_mis_hear() {
    let key = model::make_key();
    assert!(key.starts_with("VLX-"), "{key}");
    assert_eq!(key.len(), 21, "VLX plus three blocks of five: {key}");
    // No O against 0, no I against 1: these are read out over the phone.
    assert!(!key[4..].contains(['O', 'I', '0', '1']), "{key}");
    assert_ne!(model::make_key(), model::make_key(), "two keys are not the same key");
}

#[test]
fn an_address_is_checked_before_a_key_is_spent_on_it() {
    assert!(model::email_ok("buyer@example.com"));
    assert!(model::email_ok("first.last+tag@sub.example.co.uk"));
    assert!(!model::email_ok("no-at-sign.example.com"));
    assert!(!model::email_ok("two@@example.com"));
    assert!(!model::email_ok("nodomain@x"));
    assert!(!model::email_ok("spaces in@example.com"));
    assert!(!model::email_ok(""));
    assert!(!model::email_ok(&format!("{}@example.com", "x".repeat(250))));
}

#[test]
fn a_stranger_sees_enough_to_recognise_their_own_address_and_no_more() {
    // Two letters, then one star per hidden character. The length of the name is
    // part of what makes someone recognise their own address, and this is the
    // message the app has always shown.
    assert_eq!(model::mask_email("buyer@example.com"), "bu***@example.com");
    assert_eq!(model::mask_email("someone@example.com"), "so*****@example.com");
    assert_eq!(model::mask_email("ab@example.com"), "ab*@example.com", "always at least one star");
    assert_eq!(model::mask_email("a@example.com"), "a*@example.com");
    // Nothing to mask, so nothing is said. "another account" is the phrase the
    // message is built around.
    assert_eq!(model::mask_email("@example.com"), "another account");
    assert_eq!(model::mask_email("not-an-address"), "another account");
}
