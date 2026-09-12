//! The admin API, driven through the real router.
//!
//! These send actual requests — methods, paths, cookies, status codes — because
//! that is where this half of the server lives. The panel's HTML is the Node
//! server's and unported, so anything these get wrong about a field name is
//! something an operator would find by opening the panel to an empty table.
//!
//! The session is the first thing tested and the most important: every route
//! here can revoke a licence, hand out a free one, or change what the website
//! charges.

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

const PASS: &str = "a-test-only-admin-password";

fn server() -> (Shared, PathBuf) {
    // A directory of its own for the cookie jar: these tests write one, and
    // nothing about them should touch the real server's data.
    let dir = std::env::temp_dir().join(format!("velox-admin-test-{}", model::now_ms()));
    let _ = std::fs::create_dir_all(&dir);

    let db = Db::open_memory().unwrap();
    importer::import_value(
        &db,
        &json!({
            "keys": {
                "VLX-PAID-00000-00000": { "email": "paid@example.com", "trial": 0, "device_id": "DEV-P",
                                          "created_at": 2000, "plan": "lifetime" },
                "VLX-TRIAL-0000-00000": { "email": "trial@example.com", "trial": 1, "device_id": "DEV-T",
                                          "created_at": 1000 }
            },
            "devices": {
                "DEV-P": { "email": "paid@example.com", "key": "VLX-PAID-00000-00000", "updatedAt": 20 },
                "DEV-T": { "email": "trial@example.com", "key": "VLX-TRIAL-0000-00000",
                           "trialDownloads": 3, "updatedAt": 10 }
            },
            "plans": [
                { "id": "lifetime", "name": "Lifetime", "price": "LKR 6999", "period": "one time",
                  "devices": 3, "features": ["Pay once"], "active": true, "order": 1 }
            ]
        }),
    )
    .unwrap();

    let state: Shared = Arc::new(AppState {
        db,
        tokens: Tokens::new("a-test-only-secret", 24),
        extractor: Extractor::from_env(None),
        usage: DailyUsage::new(300, 6),
        jar: Jar::new(&dir),
        limits: Limits::from_env(),
        admin_user: "admin".into(),
        admin_pass: PASS.into(),
        internal_token: "test-internal-token".into(),
        trial_downloads: 5,
        default_license_days: 30,
        default_device_limit: 1,
        signup_per_hour: 60,
        started: Instant::now(),
    });
    (state, dir)
}

/// One request through the whole router, exactly as a browser would send it.
async fn send(state: &Shared, method: Method, path: &str, cookie: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(c) = cookie {
        builder = builder.header(header::COOKIE, c);
    }
    let request = match body {
        Some(json) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };

    let response = app(state.clone(), &PathBuf::from("../server/public"))
        .oneshot(request)
        .await
        .expect("the router answered");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

async fn get(state: &Shared, path: &str, cookie: &str) -> (StatusCode, Value) {
    send(state, Method::GET, path, Some(cookie), None).await
}

async fn post(state: &Shared, path: &str, cookie: &str, body: Value) -> (StatusCode, Value) {
    send(state, Method::POST, path, Some(cookie), Some(body)).await
}

/// A cookies.txt as the panel sends it: raw text, not JSON. Wrapping it in JSON
/// only to unwrap it here would double the size of a file for nothing.
async fn post_text(state: &Shared, path: &str, cookie: &str, text: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from(text.to_string()))
        .unwrap();
    let response = app(state.clone(), &PathBuf::from("../server/public")).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// Signs in and returns the cookie the panel would then send.
async fn signed_in(state: &Shared) -> String {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/admin-login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "username": "admin", "password": PASS }).to_string()))
        .unwrap();
    let response = app(state.clone(), &PathBuf::from("../server/public")).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK, "the test password signs in");
    let set = response
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .expect("a session cookie comes back")
        .to_string();
    set.split(';').next().unwrap().to_string()
}

// ------------------------------------------------------------------ session

#[tokio::test]
async fn the_panel_is_shut_to_anyone_without_a_session() {
    let (state, _dir) = server();
    // Every shape of "no session": none at all, a forged one, and a licence
    // token, which is signed with the same secret and must still not get in.
    let licence = state.tokens.issue("VLX-PAID-00000-00000", "DEV-P", None).unwrap();
    for cookie in ["", "velox_admin=not-a-token", &format!("velox_admin={licence}")] {
        let (status, body) = get(&state, "/admin/api/keys", cookie).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "cookie {cookie:?} must not be let in");
        assert_eq!(body["ok"], json!(false));
    }

    // And the mutating routes, which is where it would actually hurt.
    let (status, _) = post(&state, "/admin/api/keys/VLX-PAID-00000-00000/revoke", "", json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        !model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap().revoked,
        "and nothing happened to the licence"
    );
}

#[tokio::test]
async fn the_wrong_password_does_not_say_which_half_was_wrong() {
    let (state, _dir) = server();
    let mut seen = Vec::new();
    for (u, p) in [("admin", "wrong"), ("nobody", PASS), ("nobody", "wrong")] {
        let (status, body) = send(
            &state,
            Method::POST,
            "/api/admin-login",
            None,
            Some(json!({ "username": u, "password": p })),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        seen.push(body["error"].as_str().unwrap_or_default().to_string());
    }
    assert_eq!(seen[0], seen[1], "a real username with a bad password reads the same as a bad username");
    assert_eq!(seen[1], seen[2]);
    assert_eq!(seen[0], "invalid credentials");
}

#[tokio::test]
async fn signing_in_is_written_down_and_so_is_failing_to() {
    let (state, _dir) = server();
    let _ = send(
        &state,
        Method::POST,
        "/api/admin-login",
        None,
        Some(json!({ "username": "admin", "password": "wrong" })),
    )
    .await;
    let cookie = signed_in(&state).await;
    let (_, body) = get(&state, "/admin/api/events", &cookie).await;
    let kinds: Vec<&str> = body["events"].as_array().unwrap().iter().filter_map(|e| e["type"].as_str()).collect();
    assert!(kinds.contains(&"admin-login-fail"), "{kinds:?}");
    assert!(kinds.contains(&"admin-login"), "{kinds:?}");
}

#[tokio::test]
async fn logging_out_takes_the_cookie_back() {
    let (state, _dir) = server();
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/admin-logout")
        .body(Body::empty())
        .unwrap();
    let response = app(state.clone(), &PathBuf::from("../server/public")).oneshot(request).await.unwrap();
    let set = response.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(set.contains("Max-Age=0"), "{set}");
    assert!(set.contains("HttpOnly"), "a script must never be able to read it: {set}");
}

// ------------------------------------------------------------- panel files
//
// The panel is HTML and JS, not only an API. The HTML lists everything the panel
// can do and the JS is a map of every endpoint, so both are behind the session
// as well.

/// The response without reading the body — these check status and headers.
async fn head_of(state: &Shared, path: &str, cookie: Option<&str>) -> (StatusCode, Option<String>, String) {
    let mut builder = Request::builder().method(Method::GET).uri(path);
    if let Some(c) = cookie {
        builder = builder.header(header::COOKIE, c);
    }
    let response = app(state.clone(), &PathBuf::from("../server/public"))
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let location = response.headers().get(header::LOCATION).and_then(|v| v.to_str().ok()).map(str::to_string);
    let body = String::from_utf8_lossy(&response.into_body().collect().await.unwrap().to_bytes()).into_owned();
    (status, location, body)
}

#[tokio::test]
async fn the_panels_own_files_are_behind_the_session_too() {
    let (state, _dir) = server();

    let (status, location, _) = head_of(&state, "/admin/", None).await;
    assert!(status.is_redirection(), "a stranger is sent to sign in, not shown the panel: {status}");
    assert_eq!(location.as_deref(), Some("/login"));

    // The JS in particular: it names every endpoint this server has.
    let (status, _, _) = head_of(&state, "/admin/admin.js", None).await;
    assert_ne!(status, StatusCode::OK, "the panel script is not public");

    let (status, location, _) = head_of(&state, "/", None).await;
    assert!(status.is_redirection());
    assert_eq!(location.as_deref(), Some("/login"));
}

#[tokio::test]
async fn the_panel_opens_for_someone_signed_in() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;

    let (status, _, body) = head_of(&state, "/admin/", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK, "the index is served for a directory request");
    assert!(body.contains("admin.js"), "and it is the real panel, not a placeholder");

    let (status, location, _) = head_of(&state, "/", Some(&cookie)).await;
    assert!(status.is_redirection());
    assert_eq!(location.as_deref(), Some("/admin/"));
}

#[tokio::test]
async fn the_sign_in_page_and_its_stylesheet_stay_public() {
    let (state, _dir) = server();
    // Otherwise nobody could ever sign in, and the page would be unstyled.
    let (status, _, body) = head_of(&state, "/login", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.to_lowercase().contains("<form") || body.to_lowercase().contains("password"), "it is the sign-in page");

    let (status, _, body) = head_of(&state, "/admin/admin.css", None).await;
    assert_eq!(status, StatusCode::OK, "a stylesheet gives nothing away");
    assert!(!body.is_empty());
}

// --------------------------------------------------------------------- keys

#[tokio::test]
async fn the_key_table_carries_what_the_panel_draws() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = get(&state, "/admin/api/keys", &cookie).await;
    assert_eq!(status, StatusCode::OK);

    let keys = body["keys"].as_array().expect("a list of keys");
    assert_eq!(keys.len(), 2);
    // Newest first, as the panel expects.
    assert_eq!(keys[0]["key"], json!("VLX-PAID-00000-00000"));

    let trial = keys.iter().find(|k| k["key"] == json!("VLX-TRIAL-0000-00000")).unwrap();
    assert_eq!(trial["status"], json!("active"));
    assert_eq!(trial["trial"], json!(true));
    assert_eq!(trial["trial_used"], json!(3), "spent on the machine, not the key");
    assert_eq!(trial["trial_total"], json!(5));
    assert_eq!(trial["devices_used"], json!(1));
    assert_eq!(trial["devices_limit"], json!(1));

    let paid = keys.iter().find(|k| k["key"] == json!("VLX-PAID-00000-00000")).unwrap();
    assert_eq!(paid["trial_total"], Value::Null, "a paid key has no trial to show");
    assert_eq!(paid["devices_limit"], json!(3), "its plan allows three machines");
    // The panel reads these by name; a rename here shows up as blank columns.
    for field in ["created_at", "expires_at", "days_remaining", "device_id", "device_name", "note", "block_reason"] {
        assert!(paid.get(field).is_some(), "the table needs {field}");
    }
}

#[tokio::test]
async fn a_key_an_admin_makes_is_a_paid_one() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = post(
        &state,
        "/admin/api/keys",
        &cookie,
        json!({ "email": "New@Example.com ", "days": 365, "note": "paid by bank transfer" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let key = body["key"].as_str().unwrap();
    let row = model::find_key(&state.db, key).expect("the key is in the ledger");
    assert_eq!(row.email.as_deref(), Some("new@example.com"), "the address is stored lower-case");
    assert!(!row.trial, "an admin handing someone a licence is not handing them a trial");
    let days = model::days_remaining(row.expires_at).unwrap();
    assert!((364..=365).contains(&days), "a year, give or take the clock: {days}");
}

#[tokio::test]
async fn a_lifetime_key_has_no_expiry_at_all() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (_, body) = post(&state, "/admin/api/keys", &cookie, json!({ "email": "forever@example.com", "days": 0 })).await;
    assert_eq!(body["expiresAt"], Value::Null);
    assert_eq!(model::find_key(&state.db, body["key"].as_str().unwrap()).unwrap().expires_at, None);
}

#[tokio::test]
async fn a_nonsense_licence_length_is_refused() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    for days in [json!(-5), json!(999_999), json!("soon")] {
        let (status, _) = post(&state, "/admin/api/keys", &cookie, json!({ "email": "x@example.com", "days": days })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "days {days} must be refused");
    }
    let (status, _) = post(&state, "/admin/api/keys", &cookie, json!({ "email": "not an address" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn changing_an_address_moves_the_machines_with_it() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = send(
        &state,
        Method::PATCH,
        "/admin/api/keys/VLX-PAID-00000-00000",
        Some(&cookie),
        Some(json!({ "email": "moved@example.com", "note": "moved house" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        model::find_device(&state.db, "DEV-P").unwrap().email.as_deref(),
        Some("moved@example.com"),
        "or the old address would keep the hardware lock"
    );
}

#[tokio::test]
async fn an_expiry_the_panel_sends_as_a_date_is_understood() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = send(
        &state,
        Method::PATCH,
        "/admin/api/keys/VLX-PAID-00000-00000",
        Some(&cookie),
        Some(json!({ "expiresAt": "2030-06-01" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap().expires_at,
        Some(1_906_502_400_000),
        "read as midnight UTC on that day"
    );

    // Something that is not a date has to be refused, not quietly read as
    // "never expires" — that would hand someone a free lifetime licence.
    let (status, _) = send(
        &state,
        Method::PATCH,
        "/admin/api/keys/VLX-PAID-00000-00000",
        Some(&cookie),
        Some(json!({ "expiresAt": "next Tuesday" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap().expires_at.is_some());
}

#[tokio::test]
async fn a_device_allowance_can_be_set_or_handed_back_to_the_plan() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let patch = |value: Value| {
        let cookie = cookie.clone();
        let state = state.clone();
        async move {
            send(
                &state,
                Method::PATCH,
                "/admin/api/keys/VLX-TRIAL-0000-00000",
                Some(&cookie),
                Some(json!({ "deviceLimit": value })),
            )
            .await
        }
    };

    let (status, _) = patch(json!(4)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(model::find_key(&state.db, "VLX-TRIAL-0000-00000").unwrap().device_limit, Some(4));

    // Blank means "follow the plan", which is what most keys should do.
    let (status, _) = patch(json!("")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(model::find_key(&state.db, "VLX-TRIAL-0000-00000").unwrap().device_limit, None);

    let (status, body) = patch(json!(500)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
async fn a_key_cannot_be_put_on_a_plan_that_does_not_exist() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, _) = send(
        &state,
        Method::PATCH,
        "/admin/api/keys/VLX-TRIAL-0000-00000",
        Some(&cookie),
        Some(json!({ "plan": "does-not-exist" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &state,
        Method::PATCH,
        "/admin/api/keys/VLX-TRIAL-0000-00000",
        Some(&cookie),
        Some(json!({ "plan": "lifetime" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(model::find_key(&state.db, "VLX-TRIAL-0000-00000").unwrap().plan.as_deref(), Some("lifetime"));
}

#[tokio::test]
async fn extending_adds_to_what_is_left_but_restarts_a_lapsed_one() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;

    // Still running: 10 days left, extended by 30, is 40.
    let ten_days = model::now_ms() + 10 * model::DAY_MS;
    model::update_key(&state.db, "VLX-PAID-00000-00000", Some("paid@example.com"), None, Some(ten_days));
    let (status, body) = post(&state, "/admin/api/keys/VLX-PAID-00000-00000/extend", &cookie, json!({ "days": 30 })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["key"]["days_remaining"], json!(40));

    // Long lapsed: it starts again from today, so nobody pays for time they
    // could not use.
    model::update_key(&state.db, "VLX-TRIAL-0000-00000", None, None, Some(1_000));
    let (_, body) = post(&state, "/admin/api/keys/VLX-TRIAL-0000-00000/extend", &cookie, json!({ "days": 7 })).await;
    assert_eq!(body["key"]["days_remaining"], json!(7));

    let (status, _) = post(&state, "/admin/api/keys/VLX-PAID-00000-00000/extend", &cookie, json!({ "days": 0 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "an extension of nothing is a mistake, not a no-op");
}

#[tokio::test]
async fn block_and_revoke_are_written_down_with_their_reason() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;

    post(&state, "/admin/api/keys/VLX-PAID-00000-00000/block", &cookie, json!({ "reason": "chargeback" })).await;
    let row = model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap();
    assert!(row.blocked);
    assert_eq!(model::state_of(&row), model::State::Blocked);

    post(&state, "/admin/api/keys/VLX-PAID-00000-00000/unblock", &cookie, json!({})).await;
    assert!(!model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap().blocked);

    post(&state, "/admin/api/keys/VLX-PAID-00000-00000/revoke", &cookie, json!({})).await;
    assert!(model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap().revoked);
    post(&state, "/admin/api/keys/VLX-PAID-00000-00000/unrevoke", &cookie, json!({})).await;
    assert!(!model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap().revoked);

    let (_, events) = get(&state, "/admin/api/events", &cookie).await;
    let log: Vec<&Value> = events["events"].as_array().unwrap().iter().collect();
    let block = log.iter().find(|e| e["type"] == json!("admin-block")).expect("the block is in the log");
    assert_eq!(block["detail"], json!("chargeback"), "why, not just what");
    assert_eq!(block["key"], json!("VLX-PAID-00000-00000"));
}

#[tokio::test]
async fn a_paid_up_trial_stops_being_a_trial() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = post(&state, "/admin/api/keys/VLX-TRIAL-0000-00000/make-paid", &cookie, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!model::find_key(&state.db, "VLX-TRIAL-0000-00000").unwrap().trial);
    assert_eq!(body["key"]["trial_total"], Value::Null, "and the download cap is gone with it");
}

#[tokio::test]
async fn moving_to_new_hardware_unbinds_every_machine_but_keeps_the_trial_count() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = post(&state, "/admin/api/keys/VLX-TRIAL-0000-00000/reset-device", &cookie, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["unboundDevices"], json!(1));

    let row = model::find_key(&state.db, "VLX-TRIAL-0000-00000").unwrap();
    assert_eq!(row.device_id, None, "or the old machine would stay bound and they could never activate");
    assert_eq!(model::bound_devices(&state.db, &row).len(), 0);
    assert_eq!(
        model::find_device(&state.db, "DEV-T").unwrap().trial_downloads,
        3,
        "a reset is not a way to farm fresh free trials"
    );
}

#[tokio::test]
async fn an_unknown_key_is_a_404_not_a_silent_success() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    for path in [
        "/admin/api/keys/VLX-NOPE-00000-00000/extend",
        "/admin/api/keys/VLX-NOPE-00000-00000/make-paid",
    ] {
        let (status, _) = post(&state, path, &cookie, json!({ "days": 30 })).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    let (status, _) = send(
        &state,
        Method::PATCH,
        "/admin/api/keys/VLX-NOPE-00000-00000",
        Some(&cookie),
        Some(json!({ "note": "x" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_key_is_typed_however_it_is_typed() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    // Lower case with a stray space, as it arrives from a copy and paste.
    let (status, _) = post(&state, "/admin/api/keys/vlx-paid-00000-00000/revoke", &cookie, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap().revoked);
}

// ------------------------------------------------------------------ devices

#[tokio::test]
async fn the_device_table_says_what_each_machine_has_left() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = get(&state, "/admin/api/devices", &cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["trialCap"], json!(5));

    let devices = body["devices"].as_array().unwrap();
    let t = devices.iter().find(|d| d["deviceId"] == json!("DEV-T")).unwrap();
    assert_eq!(t["trialDownloads"], json!(3));
    assert_eq!(t["trialRemaining"], json!(2));
    assert_eq!(t["keyStatus"], json!("active"), "a machine on a dead key looks different in the table");
    assert_eq!(t["email"], json!("trial@example.com"));
}

#[tokio::test]
async fn forgiving_a_trial_and_moving_an_account_are_different_buttons() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;

    post(&state, "/admin/api/devices/DEV-T/reset-trial", &cookie, json!({})).await;
    let device = model::find_device(&state.db, "DEV-T").unwrap();
    assert_eq!(device.trial_downloads, 0, "the downloads came back");
    assert_eq!(device.email.as_deref(), Some("trial@example.com"), "and the account did not move");

    post(&state, "/admin/api/devices/DEV-T/unbind", &cookie, json!({})).await;
    assert!(
        model::find_device(&state.db, "DEV-T").unwrap().email.is_none(),
        "unbinding frees the machine for a different account"
    );
}

#[tokio::test]
async fn removing_a_second_machine_does_not_disturb_the_first() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let key = model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap();
    model::bind_device(&state.db, &key, "DEV-P2", "the laptop");

    // Take the key's *primary* machine away. Another of its machines has to take
    // that place, or the customer's remaining PC would stop being recognised.
    post(&state, "/admin/api/devices/DEV-P/unbind", &cookie, json!({})).await;
    let row = model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap();
    assert_eq!(row.device_id.as_deref(), Some("DEV-P2"));
    assert_eq!(model::state_of(&row), model::State::Active, "the licence is still working");
}

#[tokio::test]
async fn deleting_the_last_machine_leaves_the_key_pointing_at_nothing() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = send(&state, Method::DELETE, "/admin/api/devices/DEV-P", Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(model::find_device(&state.db, "DEV-P").is_none());
    let row = model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap();
    assert_eq!(row.device_id, None);
    assert_eq!(model::state_of(&row), model::State::Pending, "issued, waiting for a machine again");
}

// ----------------------------------------------------------------- settings

#[tokio::test]
async fn the_settings_round_trip_in_the_shape_the_panel_reads() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = get(&state, "/admin/api/settings", &cookie).await;
    assert_eq!(status, StatusCode::OK);
    for field in ["signupEnabled", "trialDownloads", "defaultLicenseDays", "defaultDeviceLimit", "signupPerHour"] {
        assert!(body["settings"].get(field).is_some(), "the panel needs {field}");
    }

    let (status, body) = post(
        &state,
        "/admin/api/settings",
        &cookie,
        json!({ "signupEnabled": false, "trialDownloads": 3, "defaultDeviceLimit": 2, "signupPerHour": 0 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["settings"]["signupEnabled"], json!(false));
    assert_eq!(body["settings"]["trialDownloads"], json!(3));
    // 0 means no limit, and has to survive being saved: an operator sets it
    // because a cap is blocking real customers behind one carrier address.
    assert_eq!(body["settings"]["signupPerHour"], json!(0));
    assert_eq!(model::signup_per_hour(&state.db, 60), 0);
}

#[tokio::test]
async fn a_setting_outside_its_range_is_refused_rather_than_clamped() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    for body in [
        json!({ "trialDownloads": 0 }),
        json!({ "trialDownloads": 99_999 }),
        json!({ "defaultDeviceLimit": 50 }),
        json!({ "defaultLicenseDays": -1 }),
        json!({ "signupPerHour": "lots" }),
    ] {
        let (status, _) = post(&state, "/admin/api/settings", &cookie, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body} must be refused");
    }
    // Nothing was written by any of those.
    let s = model::settings(&state.db, (5, 30, 1));
    assert_eq!(s.trial_downloads, 5);
    assert_eq!(s.default_device_limit, 1);
}

// -------------------------------------------------------------------- plans

#[tokio::test]
async fn the_pricing_table_is_saved_as_one_list() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = post(
        &state,
        "/admin/api/plans",
        &cookie,
        json!({ "plans": [
            { "name": "1 Month", "price": "LKR 999", "period": "per month", "devices": 1,
              "features": ["Everything"], "active": true, "order": 1 },
            { "name": "1 Year", "price": "LKR 7999", "period": "per year", "devices": 2,
              "active": true, "highlight": true, "order": 2 },
            { "name": "Not finished", "price": "", "period": "one time", "active": false, "order": 3 }
        ] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let plans = body["plans"].as_array().unwrap();
    assert_eq!(plans.len(), 3, "the old seeded plan is gone: the list *is* the table");
    assert_eq!(plans[0]["id"], json!("1-month"), "an id nobody typed comes from the name");
    assert_eq!(plans[1]["devices"], json!(2));

    // Only finished plans reach a customer, and the website reads the same list.
    let published = model::public_plans(&state.db);
    assert_eq!(published.len(), 2, "the draft with no price stays in the panel");
    assert!(published.iter().all(|p| !p.price.is_empty()));
}

#[tokio::test]
async fn a_broken_pricing_table_is_refused_whole() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let before = model::all_plans(&state.db).len();
    for plans in [
        json!({ "plans": [{ "price": "LKR 1" }] }),
        json!({ "plans": [{ "name": "A", "period": "per fortnight" }] }),
        json!({ "plans": [{ "name": "A", "id": "same" }, { "name": "B", "id": "same" }] }),
        json!({ "plans": "not a list" }),
    ] {
        let (status, body) = post(&state, "/admin/api/plans", &cookie, plans.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{plans} -> {body}");
        assert!(body["error"].as_str().unwrap_or_default().len() > 5, "and it says what is wrong: {body}");
    }
    assert_eq!(model::all_plans(&state.db).len(), before, "a refused save changes nothing");
}

// ------------------------------------------------------------------ notices

#[tokio::test]
async fn a_notice_is_written_here_and_reaches_only_its_audience() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, body) = post(
        &state,
        "/admin/api/notices",
        &cookie,
        json!({
            "title": "Half price this week",
            "body": "Upgrade and keep your downloads.",
            "audience": "trial",
            "level": "promo",
            "actionLabel": "See plans",
            "actionUrl": "https://veloxdownloader.prolanka.online/#pricing"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = body["notice"]["id"].as_str().unwrap().to_string();

    let trial = model::find_key(&state.db, "VLX-TRIAL-0000-00000").unwrap();
    let paid = model::find_key(&state.db, "VLX-PAID-00000-00000").unwrap();
    assert_eq!(model::notices_for(&state.db, &trial, Some(2)).len(), 1);
    assert_eq!(model::notices_for(&state.db, &paid, None).len(), 0, "a trial offer must not go to a subscriber");

    // The switch on its own is the common edit.
    let (status, _) = send(
        &state,
        Method::PATCH,
        &format!("/admin/api/notices/{id}"),
        Some(&cookie),
        Some(json!({ "active": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(model::notices_for(&state.db, &trial, Some(2)).len(), 0);

    // An edit that mentions one field keeps the rest.
    let (_, body) = send(
        &state,
        Method::PATCH,
        &format!("/admin/api/notices/{id}"),
        Some(&cookie),
        Some(json!({ "title": "Half price - last day", "active": true })),
    )
    .await;
    let notice = body["notices"].as_array().unwrap().iter().find(|n| n["id"] == json!(id)).unwrap();
    assert_eq!(notice["title"], json!("Half price - last day"));
    assert_eq!(notice["audience"], json!("trial"), "the audience was not mentioned and did not change");
    assert_eq!(notice["actionUrl"], json!("https://veloxdownloader.prolanka.online/#pricing"));

    let (status, body) = send(&state, Method::DELETE, &format!("/admin/api/notices/{id}"), Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["notices"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn a_notice_button_can_only_point_somewhere_safe() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    for bad in ["http://example.com", "javascript:alert(1)", "file:///etc/passwd"] {
        let (status, body) = post(
            &state,
            "/admin/api/notices",
            &cookie,
            json!({ "title": "Look", "actionUrl": bad }),
        )
        .await;
        // The app opens this on the customer's machine, so it is refused here
        // rather than there.
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        assert!(body["error"].as_str().unwrap().contains("https"), "{body}");
    }

    for body in [json!({ "body": "no title" }), json!({ "title": "x", "audience": "everyone" }), json!({ "title": "x", "level": "shout" })] {
        let (status, _) = post(&state, "/admin/api/notices", &cookie, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    assert_eq!(model::count_notices(&state.db), 0);
}

#[tokio::test]
async fn editing_a_notice_that_is_gone_is_a_404() {
    let (state, _dir) = server();
    let cookie = signed_in(&state).await;
    let (status, _) = send(
        &state,
        Method::PATCH,
        "/admin/api/notices/nothinghere",
        Some(&cookie),
        Some(json!({ "active": true })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&state, Method::DELETE, "/admin/api/notices/nothinghere", Some(&cookie), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ------------------------------------------------------------------ cookies

#[tokio::test]
async fn the_cookie_jar_is_checked_before_it_is_stored() {
    let (state, dir) = server();
    let cookie = signed_in(&state).await;

    // Well-formed but signed out: the most common upload mistake, and it must
    // not replace a working jar.
    let signed_out = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tVISITOR_INFO1_LIVE\tabc\n";
    let (status, body) = post_text(&state, "/admin/api/cookies", &cookie, signed_out).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"].as_str().unwrap().contains("Sign in first"), "{body}");
    assert!(!dir.join("yt-cookies.txt").exists(), "nothing was stored");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_real_jar_is_stored_and_never_comes_back_out() {
    let (state, dir) = server();
    let cookie = signed_in(&state).await;
    let live = format!(
        "# Netscape HTTP Cookie File\n\
         .youtube.com\tTRUE\t/\tTRUE\t{expiry}\tSID\tthe-secret-value\n\
         .youtube.com\tTRUE\t/\tTRUE\t{expiry}\t__Secure-1PSID\tanother-secret\n\
         #HttpOnly_.google.com\tTRUE\t/\tTRUE\t{expiry}\tSAPISID\tthird-secret\n",
        expiry = model::now_ms() / 1000 + 30 * 86_400
    );

    let (status, body) = post_text(&state, "/admin/api/cookies", &cookie, &live).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let jar = &body["cookies"];
    assert_eq!(jar["present"], json!(true));
    assert_eq!(jar["session"], json!(3), "the #HttpOnly_ line is a cookie, not a comment");
    assert!(jar["sessionNames"].as_array().unwrap().contains(&json!("SID")));

    // The names are shown; no value ever is.
    let shown = serde_json::to_string(&body).unwrap();
    for secret in ["the-secret-value", "another-secret", "third-secret"] {
        assert!(!shown.contains(secret), "a cookie value must never leave the server: {secret}");
    }
    let (_, status_body) = get(&state, "/admin/api/cookies", &cookie).await;
    let shown = serde_json::to_string(&status_body).unwrap();
    assert!(!shown.contains("the-secret-value"));

    // Nor may it reach the audit log.
    let (_, events) = get(&state, "/admin/api/events", &cookie).await;
    let log = serde_json::to_string(&events).unwrap();
    assert!(log.contains("yt-cookies-upload"), "the upload is recorded");
    assert!(!log.contains("the-secret-value"), "but not what was in it");

    let (status, body) = send(&state, Method::DELETE, "/admin/api/cookies", Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cookies"]["present"], json!(false));
    assert!(!dir.join("yt-cookies.txt").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

// ----------------------------------------------------------------- internal

#[tokio::test]
async fn a_forwarded_request_is_never_a_local_one() {
    let (state, _dir) = server();
    // The hole this closes: behind a proxy every request arrives from 127.0.0.1,
    // so the peer address alone cannot tell the store service next door from
    // somebody on the internet. A forwarded-for header is the proxy saying where
    // the request really came from.
    //
    // Everything else here is in order - a loopback peer and the right token - so
    // the header is the only thing standing in the way.
    let mut request = Request::builder()
        .method(Method::POST)
        .uri("/internal/issue-key")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", "203.0.113.9")
        .header("x-internal-token", "test-internal-token")
        .body(Body::from(json!({ "email": "outsider@example.com", "days": 365 }).to_string()))
        .unwrap();
    request.extensions_mut().insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
        [127, 0, 0, 1],
        44444,
    ))));

    let response = app(state.clone(), &PathBuf::from("../server/public"))
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(
        model::find_by_email(&state.db, "outsider@example.com").is_none(),
        "no licence was handed out"
    );
}

#[tokio::test]
async fn a_genuine_local_call_still_gets_its_key() {
    let (state, _dir) = server();
    // The other half: the store service, on this machine, with the token, and no
    // proxy in between. If this stops working nobody who pays gets a key.
    let mut request = Request::builder()
        .method(Method::POST)
        .uri("/internal/issue-key")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-internal-token", "test-internal-token")
        .body(Body::from(json!({ "email": "Buyer@Example.com", "days": 365, "note": "payhere" }).to_string()))
        .unwrap();
    request.extensions_mut().insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
        [127, 0, 0, 1],
        44445,
    ))));

    let response = app(state.clone(), &PathBuf::from("../server/public")).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let key = body["key"].as_str().expect("a key for the buyer");
    let row = model::find_key(&state.db, key).expect("and it is in the ledger");
    assert_eq!(row.email.as_deref(), Some("buyer@example.com"), "stored lower-case");
    assert!(!row.trial, "somebody who paid is not on a trial");
    assert_eq!(model::days_remaining(row.expires_at), Some(365));
}

#[tokio::test]
async fn a_local_call_without_the_token_gets_nothing() {
    let (state, _dir) = server();
    let mut request = Request::builder()
        .method(Method::POST)
        .uri("/internal/issue-key")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-internal-token", "not-the-token")
        .body(Body::from(json!({ "email": "thief@example.com", "days": 3650 }).to_string()))
        .unwrap();
    request.extensions_mut().insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
        [127, 0, 0, 1],
        44446,
    ))));
    let response = app(state.clone(), &PathBuf::from("../server/public")).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(model::find_by_email(&state.db, "thief@example.com").is_none());
}

#[tokio::test]
async fn the_internal_route_is_shut_to_the_internet() {
    let (state, _dir) = server();
    // No session is involved: this one is for the store service, and it is
    // guarded by a token and by the peer address. Driving the router directly
    // has no peer address at all, which stands in for "not loopback".
    let (status, body) = send(
        &state,
        Method::POST,
        "/internal/issue-key",
        None,
        Some(json!({ "email": "buyer@example.com", "days": 365 })),
    )
    .await;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::INTERNAL_SERVER_ERROR,
        "a request with no loopback peer must not mint a key: {status} {body}"
    );
    assert!(model::find_by_email(&state.db, "buyer@example.com").is_none(), "no key was minted");
}
