//! The three doors the app knocks on, and what each refusal says.
//!
//! The heartbeat is the one every running copy of the app polls, so its answers
//! are the ones a customer actually sees: which screen the app shows, and whether
//! the pricing is on it. The words and the flags are read by name, and one of
//! these was got wrong in the port — a key that had been issued but never used on
//! a machine was told "license expired", which would send someone who already
//! holds a licence to the shop to buy another.

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Instant};
use tower::ServiceExt;
use velox_license::{
    app::app,
    auth::Tokens,
    cookies::Jar,
    db::Db,
    extract::Extractor,
    gate::DailyUsage,
    importer,
    limit::Limits,
    model,
    routes::{AppState, Shared},
};

fn server() -> Shared {
    let db = Db::open_memory().unwrap();
    importer::import_value(
        &db,
        &json!({
            "keys": {
                // Issued and never used: the state the port got wrong.
                "VLX-WAIT-00000-00000": { "email": "waiting@example.com", "trial": 0 },
                "VLX-LIVE-00000-00000": { "email": "live@example.com", "trial": 0, "device_id": "DEV-L" },
                "VLX-GONE-00000-00000": { "email": "gone@example.com", "trial": 0, "device_id": "DEV-G", "expires_at": 1000 },
                "VLX-STOP-00000-00000": { "email": "stop@example.com", "trial": 0, "device_id": "DEV-X", "revoked": 1 },
                "VLX-HOLD-00000-00000": { "email": "hold@example.com", "trial": 0, "device_id": "DEV-H", "blocked": 1 }
            },
            "devices": {
                "DEV-L": { "email": "live@example.com", "key": "VLX-LIVE-00000-00000" },
                "DEV-G": { "email": "gone@example.com", "key": "VLX-GONE-00000-00000" },
                "DEV-X": { "email": "stop@example.com", "key": "VLX-STOP-00000-00000" },
                "DEV-H": { "email": "hold@example.com", "key": "VLX-HOLD-00000-00000" }
            },
            "plans": [
                { "id": "yearly", "name": "1 Year", "price": "LKR 7999", "period": "per year",
                  "devices": 2, "features": ["Everything"], "active": true, "order": 1 }
            ],
            "notices": [
                { "id": "comeback", "title": "Come back", "audience": "expired", "active": true, "created_at": 5 }
            ]
        }),
    )
    .unwrap();

    Arc::new(AppState {
        db,
        tokens: Tokens::new("a-test-only-secret", 24),
        extractor: Extractor::from_env(None),
        usage: DailyUsage::new(300, 6),
        jar: Jar::new(std::path::Path::new(".")),
        limits: Limits::from_env(),
        admin_user: "admin".into(),
        admin_pass: "unused-here".into(),
        internal_token: String::new(),
        trial_downloads: 5,
        default_license_days: 30,
        default_device_limit: 1,
        signup_per_hour: 0,
        started: Instant::now(),
    })
}

async fn post(state: &Shared, path: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app(state.clone(), &PathBuf::from("../server/public")).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn token(state: &Shared, key: &str, device: &str) -> String {
    state.tokens.issue(key, device, None).unwrap()
}

// --------------------------------------------------------------- heartbeat

#[tokio::test]
async fn a_working_licence_is_told_everything_the_account_screen_shows() {
    let state = server();
    let (status, body) = post(
        &state,
        "/api/heartbeat",
        json!({ "token": token(&state, "VLX-LIVE-00000-00000", "DEV-L") }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["revoked"], json!(false));
    assert_eq!(body["blocked"], json!(false));
    assert_eq!(body["expired"], json!(false));
    // A fresh token on every beat, so a leaked one is superseded within one
    // interval rather than lasting as long as the licence.
    let fresh = body["token"].as_str().expect("a new token");
    assert!(state.tokens.verify(fresh).is_some());
    assert!(body["profile"]["plan"].is_object());
    assert!(body["plans"].is_array());
    assert!(body["notices"].is_array());
}

#[tokio::test]
async fn a_licence_that_was_never_used_is_not_an_expired_one() {
    let state = server();
    // The regression: Pending is not a refusal. It means "issued, waiting for a
    // machine", and the token naming a machine the key does not have is a device
    // question, not a licence one. Telling this customer their licence expired
    // would send them to buy one they already hold.
    let (status, body) = post(
        &state,
        "/api/heartbeat",
        json!({ "token": token(&state, "VLX-WAIT-00000-00000", "SOME-PC") }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], json!("device mismatch"));
    assert!(body.get("expired").is_none(), "and nothing that reads as expired: {body}");
}

#[tokio::test]
async fn an_expired_licence_is_shown_the_way_back() {
    let state = server();
    let (status, body) = post(
        &state,
        "/api/heartbeat",
        json!({ "token": token(&state, "VLX-GONE-00000-00000", "DEV-G") }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["expired"], json!(true));
    // The one refusal that carries an offer: someone whose subscription just ran
    // out is the person most worth making one to, and the lock screen is the only
    // surface they can act on.
    assert_eq!(body["plans"].as_array().map(Vec::len), Some(1), "{body}");
    assert_eq!(body["notices"][0]["title"], json!("Come back"));
}

#[tokio::test]
async fn a_licence_somebody_took_away_gets_no_sales_pitch() {
    let state = server();
    for (key, device, flag) in [
        ("VLX-STOP-00000-00000", "DEV-X", "revoked"),
        ("VLX-HOLD-00000-00000", "DEV-H", "blocked"),
    ] {
        let (status, body) = post(&state, "/api/heartbeat", json!({ "token": token(&state, key, device) })).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body[flag], json!(true), "the app shows a different screen for each reason: {body}");
        assert!(body.get("plans").is_none(), "a revoked or blocked licence is not a sales opportunity: {body}");
        assert!(body.get("notices").is_none(), "{body}");
    }
}

#[tokio::test]
async fn a_heartbeat_needs_a_token_that_means_something() {
    let state = server();
    let (status, body) = post(&state, "/api/heartbeat", json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], json!("missing token"));

    let (status, _) = post(&state, "/api/heartbeat", json!({ "token": "not.a.token" })).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A token for a key that has since been deleted.
    let orphan = token(&state, "VLX-NOPE-00000-00000", "DEV-L");
    let (status, _) = post(&state, "/api/heartbeat", json!({ "token": orphan })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// -------------------------------------------------------- signup, activate

#[tokio::test]
async fn the_words_a_refused_licence_is_given_are_the_same_at_every_door() {
    let state = server();
    for (key, email, message) in [
        ("VLX-STOP-00000-00000", "stop@example.com", "key revoked"),
        ("VLX-HOLD-00000-00000", "hold@example.com", "user blocked"),
        ("VLX-GONE-00000-00000", "gone@example.com", "license expired"),
    ] {
        let (status, body) = post(&state, "/api/activate", json!({ "key": key, "deviceId": "NEW-PC" })).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{key}");
        assert_eq!(body["error"], json!(message), "{key}");
        // Activation says it in the message and sends no pricing: the app has a
        // lock screen for this and fetches the plans itself.
        assert!(body.get("plans").is_none(), "{key}: {body}");

        // The same customer arriving through the sign-up door instead — trying for
        // a free trial on an address that already has a licence — is told the same
        // thing about the same licence, rather than being handed a second one.
        let (status, body) = post(&state, "/api/signup", json!({ "email": email, "deviceId": "NEW-PC" })).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{email}");
        assert_eq!(body["error"], json!(message), "{email}");
        assert!(body.get("key").is_none(), "and no new key was handed out: {body}");
    }
}

#[tokio::test]
async fn a_stranger_at_someone_elses_machine_is_told_only_enough_to_recognise_it() {
    let state = server();
    let (status, body) = post(
        &state,
        "/api/signup",
        json!({ "email": "stranger@example.com", "deviceId": "DEV-L", "deviceName": "That PC" }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let message = body["error"].as_str().unwrap();
    // Enough for the real owner to recognise their own address, not enough to
    // hand a stranger somebody else's.
    assert!(message.contains("li**@example.com"), "{message}");
    assert!(!message.contains("live@example.com"), "{message}");
    assert_eq!(body["deviceTaken"], json!(true));
}

#[tokio::test]
async fn a_second_machine_is_refused_in_the_words_of_the_allowance() {
    let state = server();
    // One machine is the rule most customers are on, and the message says so
    // rather than quoting numbers at them.
    let (status, body) = post(
        &state,
        "/api/activate",
        json!({ "key": "VLX-LIVE-00000-00000", "deviceId": "SECOND-PC", "deviceName": "Laptop" }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body["error"].as_str().unwrap().contains("already connected with another device"), "{body}");
    assert_eq!(body["devices"], json!({ "used": 1, "limit": 1 }));

    // On a plan that allows two, the same machine is let in.
    model::set_key_plan(&state.db, "VLX-LIVE-00000-00000", Some("yearly"));
    let (status, body) = post(
        &state,
        "/api/activate",
        json!({ "key": "VLX-LIVE-00000-00000", "deviceId": "SECOND-PC", "deviceName": "Laptop" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "raising a plan lifts every key sold on it: {body}");
    assert_eq!(body["profile"]["devices"], json!({ "used": 2, "limit": 2 }));
}
