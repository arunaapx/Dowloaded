//! Who reaches the extractor, and who is turned away.
//!
//! The gates are the whole business model: the app ships no extractor of its
//! own, so a request that gets past these is a download nobody paid for. These
//! test the decisions directly — no socket, no yt-dlp — because the decision is
//! the part that must never be wrong.

use axum::http::StatusCode;
use serde_json::{json, Value};
use velox_license::{
    auth::Tokens,
    cookies::Jar,
    db::Db,
    extract::Extractor,
    gate::{self, DailyUsage},
    importer,
    limit::Limits,
    model,
    routes::AppState,
};

/// A licence server in memory, with the four kinds of customer the gates have
/// to tell apart.
fn server(cap: i64, alert_at: usize) -> AppState {
    let db = Db::open_memory().unwrap();
    importer::import_value(
        &db,
        &json!({
            "keys": {
                "VLX-PAID-00000-00000": { "email": "paid@example.com", "trial": 0, "device_id": "DEV-P" },
                "VLX-TRIAL-0000-00000": { "email": "trial@example.com", "trial": 1, "device_id": "DEV-T" },
                "VLX-SPENT-0000-00000": { "email": "spent@example.com", "trial": 1, "device_id": "DEV-S" },
                "VLX-STOP-00000-00000": { "email": "stop@example.com", "trial": 0, "device_id": "DEV-X", "revoked": 1 }
            },
            "devices": {
                "DEV-P": { "email": "paid@example.com", "key": "VLX-PAID-00000-00000" },
                "DEV-T": { "email": "trial@example.com", "key": "VLX-TRIAL-0000-00000", "trialDownloads": 1 },
                "DEV-S": { "email": "spent@example.com", "key": "VLX-SPENT-0000-00000", "trialDownloads": 5 },
                "DEV-X": { "email": "stop@example.com", "key": "VLX-STOP-00000-00000" }
            }
        }),
    )
    .unwrap();

    AppState {
        db,
        tokens: Tokens::new("test-secret-for-the-gates", 24),
        // Never called here: nothing in this file gets past the gates to a
        // process, which is the point.
        extractor: Extractor::from_env(None),
        usage: DailyUsage::new(cap, alert_at),
        // Nothing in this file touches the admin side; these are here because
        // the gates live in the same state the panel does.
        jar: Jar::new(std::path::Path::new(".")),
        limits: Limits::from_env(),
        admin_user: "admin".into(),
        admin_pass: String::new(),
        internal_token: String::new(),
        trial_downloads: 5,
        default_license_days: 30,
        default_device_limit: 1,
        signup_per_hour: 60,
        started: std::time::Instant::now(),
    }
}

fn token(state: &AppState, key: &str, device: &str) -> String {
    state.tokens.issue(key, device, None).expect("a token can be issued")
}

fn licence(state: &AppState, key: &str, device: &str) -> gate::Licence {
    let t = token(state, key, device);
    gate::require_licence(state, Some(&format!("Bearer {t}")), None).expect("this licence is in order")
}

fn refusal(err: (StatusCode, axum::Json<Value>)) -> (StatusCode, Value) {
    (err.0, err.1 .0)
}

// ------------------------------------------------------- gate one: licence

#[test]
fn nothing_gets_through_without_a_token() {
    let state = server(100, 6);
    let (status, body) = refusal(gate::require_licence(&state, None, None).unwrap_err());
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["ok"], json!(false), "a refusal always says so in the body too");

    let (status, _) = refusal(gate::require_licence(&state, Some("Bearer "), Some("")).unwrap_err());
    assert_eq!(status, StatusCode::UNAUTHORIZED, "an empty token is no token");

    let (status, _) = refusal(gate::require_licence(&state, Some("Bearer not-a-token"), None).unwrap_err());
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a forged token is no token");
}

#[test]
fn a_token_in_the_body_works_like_the_header() {
    let state = server(100, 6);
    let t = token(&state, "VLX-PAID-00000-00000", "DEV-P");
    // The older app version sends it in the body; both have to keep working, or
    // the cut-over breaks everyone who has not updated.
    let from_body = gate::require_licence(&state, None, Some(&t)).expect("body token accepted");
    assert_eq!(from_body.key.key, "VLX-PAID-00000-00000");

    let from_header = gate::require_licence(&state, Some(&format!("Bearer {t}")), None).unwrap();
    assert_eq!(from_header.key.key, from_body.key.key);
}

#[test]
fn a_token_signed_by_someone_else_is_worthless() {
    let state = server(100, 6);
    let forger = Tokens::new("a-different-secret", 24);
    let t = forger.issue("VLX-PAID-00000-00000", "DEV-P", None).unwrap();
    let (status, _) = refusal(gate::require_licence(&state, Some(&format!("Bearer {t}")), None).unwrap_err());
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the signature is what makes a token a token");
}

#[test]
fn a_revoked_key_is_refused_by_name() {
    let state = server(100, 6);
    let t = token(&state, "VLX-STOP-00000-00000", "DEV-X");
    let (status, body) = refusal(gate::require_licence(&state, Some(&format!("Bearer {t}")), None).unwrap_err());
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["revoked"], json!(true), "the app shows a different screen for each reason");
}

#[test]
fn an_expired_token_is_expired_whatever_the_key_says() {
    let state = server(100, 6);
    // Correctly signed with the right secret for a real, active key — and stale.
    // A token the app kept from last week must stop working on its own, because
    // the expiry is what makes a leaked one harmless.
    let stale = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &velox_license::auth::Claims {
            key: "VLX-PAID-00000-00000".into(),
            device_id: "DEV-P".into(),
            email: None,
            exp: velox_license::model::now_ms() / 1000 - 7 * 24 * 3600,
        },
        &jsonwebtoken::EncodingKey::from_secret(b"test-secret-for-the-gates"),
    )
    .unwrap();
    let (status, _) = refusal(gate::require_licence(&state, Some(&format!("Bearer {stale}")), None).unwrap_err());
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[test]
fn a_token_is_never_issued_with_a_nonsense_lifetime() {
    // A bad TOKEN_TTL_HOURS in the environment must not mint tokens that are
    // already dead, locking every customer out until someone reads the .env.
    let misconfigured = Tokens::new("test-secret-for-the-gates", -1);
    let t = misconfigured.issue("VLX-PAID-00000-00000", "DEV-P", None).unwrap();
    assert!(misconfigured.verify(&t).is_some(), "the floor of one hour holds");
    assert!(misconfigured.ttl_seconds() >= 3600);
}

#[test]
fn a_token_for_a_machine_the_key_does_not_cover_is_refused() {
    let state = server(100, 6);
    let t = token(&state, "VLX-PAID-00000-00000", "DEV-SOMEONE-ELSE");
    let (status, body) = refusal(gate::require_licence(&state, Some(&format!("Bearer {t}")), None).unwrap_err());
    assert_eq!(status, StatusCode::CONFLICT, "copying the token to another machine buys nothing");
    assert_eq!(body["error"], json!("device mismatch"));
}

#[test]
fn a_machine_the_admin_adds_is_let_in_without_a_new_token() {
    let state = server(100, 6);
    let key = model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap();
    let t = token(&state, "VLX-PAID-00000-00000", "DEV-SECOND");
    assert!(gate::require_licence(&state, Some(&format!("Bearer {t}")), None).is_err());

    model::bind_device(&state.db, &key, "DEV-SECOND", "the laptop");
    gate::require_licence(&state, Some(&format!("Bearer {t}")), None)
        .expect("membership is checked live, so binding takes effect at once");
}

// ---------------------------------------------------- gate two: daily cap

#[test]
fn one_licence_cannot_be_resold_as_an_extraction_api() {
    let state = server(3, 99);
    let paid = licence(&state, "VLX-PAID-00000-00000", "DEV-P");
    for n in 1..=3 {
        gate::enforce_daily_cap(&state, &paid, "1.1.1.1")
            .unwrap_or_else(|_| panic!("request {n} is inside the cap"));
    }
    let (status, body) = refusal(gate::enforce_daily_cap(&state, &paid, "1.1.1.1").unwrap_err());
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(
        body["error"].as_str().unwrap().contains("tomorrow"),
        "it says when it lifts, because it does lift: {body}"
    );
}

#[test]
fn the_cap_is_counted_per_licence() {
    let state = server(2, 99);
    let paid = licence(&state, "VLX-PAID-00000-00000", "DEV-P");
    let trial = licence(&state, "VLX-TRIAL-0000-00000", "DEV-T");
    gate::enforce_daily_cap(&state, &paid, "1.1.1.1").unwrap();
    gate::enforce_daily_cap(&state, &paid, "1.1.1.1").unwrap();
    assert!(gate::enforce_daily_cap(&state, &paid, "1.1.1.1").is_err());
    gate::enforce_daily_cap(&state, &trial, "1.1.1.1")
        .expect("one customer hitting the ceiling never touches another");
}

#[test]
fn a_licence_seen_from_many_places_is_reported_and_not_blocked() {
    let state = server(100, 3);
    let paid = licence(&state, "VLX-PAID-00000-00000", "DEV-P");
    for n in 1..=6 {
        gate::enforce_daily_cap(&state, &paid, &format!("10.0.0.{n}"))
            .expect("people on mobile data and VPNs are not thieves");
    }
    assert_eq!(
        model::downloads_today(&state.db, "VLX-PAID-00000-00000"),
        0,
        "the gate counts nothing itself - only a finished download does"
    );
}

// -------------------------------------------------------- gate three: trial

#[test]
fn a_spent_trial_is_turned_away_with_the_reason_the_app_shows() {
    let state = server(100, 6);
    let spent = licence(&state, "VLX-SPENT-0000-00000", "DEV-S");
    let (status, body) = refusal(gate::enforce_trial(&state, &spent, "1.1.1.1", 5).unwrap_err());
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["trialExpired"], json!(true));
    assert!(
        body["error"].as_str().unwrap().contains('5'),
        "it says how many the trial was: {body}"
    );
}

#[test]
fn a_trial_with_downloads_left_is_told_how_many() {
    let state = server(100, 6);
    let trial = licence(&state, "VLX-TRIAL-0000-00000", "DEV-T");
    assert_eq!(
        gate::enforce_trial(&state, &trial, "1.1.1.1", 5).unwrap(),
        Some(4),
        "one already spent on this machine, four to go"
    );
}

#[test]
fn a_paying_customer_has_no_trial_to_run_out_of() {
    let state = server(100, 6);
    let paid = licence(&state, "VLX-PAID-00000-00000", "DEV-P");
    assert_eq!(gate::enforce_trial(&state, &paid, "1.1.1.1", 5).unwrap(), None);
}

// ------------------------------------------------------------- the spending

#[test]
fn a_download_is_spent_on_the_machine_and_counted_on_the_key() {
    let state = server(100, 6);
    let trial = licence(&state, "VLX-TRIAL-0000-00000", "DEV-T");
    gate::spend_download(&state, &trial);

    assert_eq!(
        model::find_device(&state.db, "DEV-T").unwrap().trial_downloads,
        2,
        "the trial is counted on the hardware, so a new email does not reset it"
    );
    assert_eq!(
        model::downloads_today(&state.db, "VLX-TRIAL-0000-00000"),
        1,
        "and on the key, which is what the account screen shows"
    );
}

#[test]
fn a_paid_download_costs_no_trial_credit() {
    let state = server(100, 6);
    let paid = licence(&state, "VLX-PAID-00000-00000", "DEV-P");
    gate::spend_download(&state, &paid);
    assert_eq!(model::find_device(&state.db, "DEV-P").unwrap().trial_downloads, 0);
    assert_eq!(model::downloads_today(&state.db, "VLX-PAID-00000-00000"), 1);
}

#[test]
fn five_downloads_is_five_downloads_however_the_trial_starts() {
    let state = server(100, 6);
    let trial = licence(&state, "VLX-TRIAL-0000-00000", "DEV-T");
    // One is already spent in the ledger, so four more finish it.
    for _ in 0..4 {
        gate::enforce_trial(&state, &trial, "1.1.1.1", 5).expect("still inside the trial");
        gate::spend_download(&state, &trial);
    }
    let (status, _) = refusal(gate::enforce_trial(&state, &trial, "1.1.1.1", 5).unwrap_err());
    assert_eq!(status, StatusCode::FORBIDDEN, "the sixth is the one that is refused");
}
