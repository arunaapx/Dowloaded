//! The three calls the desktop app makes, and the one the website makes.
//!
//! These only translate HTTP: read the body, ask `model` what the rules say,
//! answer in the shape the app already parses. Every decision — who may
//! activate, how many machines, what a trial has left, which notice reaches
//! whom — lives in `model`, where it can be tested without a socket.

use crate::{
    auth::Tokens,
    db::Db,
    model::{self, Key},
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct AppState {
    pub db: Db,
    pub tokens: Tokens,
    pub trial_downloads: i64,
    pub default_license_days: i64,
    pub default_device_limit: i64,
    pub started: std::time::Instant,
}

pub type Shared = Arc<AppState>;

// --------------------------------------------------------------- helpers

fn ok(mut payload: Value) -> Json<Value> {
    if let Some(map) = payload.as_object_mut() {
        map.insert("ok".into(), Value::Bool(true));
    }
    Json(payload)
}

fn fail(status: StatusCode, payload: Value) -> (StatusCode, Json<Value>) {
    let mut body = payload;
    if let Some(map) = body.as_object_mut() {
        map.insert("ok".into(), Value::Bool(false));
    }
    (status, Json(body))
}

fn error(status: StatusCode, message: &str) -> (StatusCode, Json<Value>) {
    fail(status, json!({ "error": message }))
}

/// The address a request came from, honouring the proxy in front of us — the
/// server only ever sees 127.0.0.1 otherwise, which would put every customer in
/// the world on one line of the audit log.
fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn settings(state: &AppState) -> model::Settings {
    model::settings(
        &state.db,
        (state.trial_downloads, state.default_license_days, state.default_device_limit),
    )
}

/// Everything the app is handed about its licence, in one place so activation
/// and the heartbeat can never disagree.
fn account_payload(state: &AppState, key: &Key) -> Value {
    let s = settings(state);
    let trial_left = model::trial_remaining(&state.db, key, s.trial_downloads);
    json!({
        "expiresAt": key.expires_at,
        "daysRemaining": model::days_remaining(key.expires_at),
        "profile": model::public_profile(&state.db, key, s.trial_downloads, s.default_device_limit),
        "plans": model::public_plans(&state.db),
        "notices": model::notices_for(&state.db, key, trial_left),
    })
}

/// A key that cannot be used, and why — in the words the app already shows.
fn refuse_state(state_of: model::State) -> Option<(StatusCode, Value)> {
    match state_of {
        model::State::Revoked => Some((StatusCode::FORBIDDEN, json!({ "error": "key revoked", "revoked": true }))),
        model::State::Blocked => Some((StatusCode::FORBIDDEN, json!({ "error": "user blocked", "blocked": true }))),
        model::State::Expired => Some((StatusCode::FORBIDDEN, json!({ "error": "license expired", "expired": true }))),
        _ => None,
    }
}

// ---------------------------------------------------------------- signup

#[derive(Deserialize)]
pub struct SignupBody {
    #[serde(default)]
    email: String,
    #[serde(default, rename = "deviceId")]
    device_id: String,
    #[serde(default, rename = "deviceName")]
    device_name: String,
}

async fn signup(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<SignupBody>,
) -> impl IntoResponse {
    let email = body.email.trim().to_lowercase();
    let device_id = body.device_id.trim().to_string();
    let device_name: String = body.device_name.trim().chars().take(100).collect();
    let ip = client_ip(&headers);
    let s = settings(&state);

    if !s.signup_enabled {
        model::log_event(&state.db, "signup-disabled", None, &ip, &email);
        return fail(
            StatusCode::FORBIDDEN,
            json!({ "error": "Free trial sign-up is closed. Please purchase a key.", "signupDisabled": true }),
        );
    }
    if !model::email_ok(&email) {
        return error(StatusCode::BAD_REQUEST, "invalid email");
    }
    // The hardware binding happens at registration, so a key never sits unbound
    // between sign-up and activation where anyone knowing the email could claim it.
    if device_id.is_empty() {
        return error(StatusCode::BAD_REQUEST, "missing device id");
    }

    if let Some(existing) = model::find_by_email(&state.db, &email) {
        if let Some((status, body)) = refuse_state(model::state_of(&existing)) {
            model::log_event(&state.db, "signup-refused", Some(&existing.key), &ip, &email);
            return fail(status, body);
        }
        let check = model::device_allowed(&state.db, &existing, &device_id, s.default_device_limit);
        if !check.allowed {
            model::log_event(&state.db, "signup-device-mismatch", Some(&existing.key), &ip, &email);
            return fail(
                StatusCode::CONFLICT,
                json!({
                    "error": model::device_limit_message(&check),
                    "deviceMismatch": true,
                    "devices": { "used": check.used, "limit": check.limit },
                }),
            );
        }
        model::bind_device(&state.db, &existing, &device_id, &device_name);
        model::log_event(&state.db, "signup-existing", Some(&existing.key), &ip, &email);
        let fresh = model::find_key(&state.db, &existing.key).unwrap_or(existing);
        return (
            StatusCode::OK,
            ok(json!({
                "key": fresh.key,
                "expiresAt": fresh.expires_at,
                "profile": model::public_profile(&state.db, &fresh, s.trial_downloads, s.default_device_limit),
                "message": "existing key returned",
            })),
        )
            .into_response_pair();
    }

    // A new email on a machine that already belongs to someone else. Refused so
    // one device cannot farm an unlimited supply of trial accounts.
    if let Some(dev) = model::find_device(&state.db, &device_id) {
        if let Some(owner) = dev.email.filter(|e| !e.is_empty() && *e != email) {
            model::log_event(&state.db, "signup-device-taken", None, &ip, &email);
            return fail(
                StatusCode::CONFLICT,
                json!({
                    "error": format!("This device is already registered to {}. One device, one account.", model::mask_email(&owner)),
                    "deviceTaken": true,
                }),
            );
        }
        // Once this machine has spent its free downloads, no new trial key:
        // swapping the email cannot reset the quota.
        if dev.trial_downloads >= s.trial_downloads {
            model::log_event(&state.db, "signup-trial-exhausted", None, &ip, &email);
            return fail(
                StatusCode::FORBIDDEN,
                json!({
                    "error": format!("Free trial finished ({} downloads) on this device. Please purchase a key.", s.trial_downloads),
                    "trialExpired": true,
                }),
            );
        }
    }

    let key = model::make_key();
    let expires_at = if s.default_license_days > 0 {
        Some(model::now_ms() + s.default_license_days * model::DAY_MS)
    } else {
        None
    };
    if model::insert_key(&state.db, &key, Some(&email), "self-signup-trial", expires_at, true).is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "could not create a key");
    }
    let row = match model::find_key(&state.db, &key) {
        Some(row) => row,
        None => return error(StatusCode::INTERNAL_SERVER_ERROR, "could not read the new key"),
    };
    model::bind_device(&state.db, &row, &device_id, &device_name);
    model::log_event(&state.db, "signup-trial", Some(&key), &ip, &email);

    let bound = model::find_key(&state.db, &key).unwrap_or(row);
    (
        StatusCode::OK,
        ok(json!({
            "key": bound.key,
            "expiresAt": bound.expires_at,
            "profile": model::public_profile(&state.db, &bound, s.trial_downloads, s.default_device_limit),
        })),
    )
        .into_response_pair()
}

// -------------------------------------------------------------- activate

#[derive(Deserialize)]
pub struct ActivateBody {
    #[serde(default)]
    key: String,
    #[serde(default, rename = "deviceId")]
    device_id: String,
    #[serde(default, rename = "deviceName")]
    device_name: String,
}

async fn activate(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<ActivateBody>,
) -> impl IntoResponse {
    let key_id = model::normalize_key(&body.key);
    let device_id = body.device_id.trim().to_string();
    let device_name: String = body.device_name.trim().chars().take(100).collect();
    let ip = client_ip(&headers);
    let s = settings(&state);

    if key_id.is_empty() || device_id.is_empty() {
        return error(StatusCode::BAD_REQUEST, "missing fields");
    }
    let row = match model::find_key(&state.db, &key_id) {
        Some(row) => row,
        None => {
            model::log_event(&state.db, "activate-unknown-key", Some(&key_id), &ip, &device_id);
            return error(StatusCode::NOT_FOUND, "unknown key");
        }
    };
    if let Some((status, body)) = refuse_state(model::state_of(&row)) {
        model::log_event(&state.db, "activate-refused", Some(&row.key), &ip, &device_id);
        return fail(status, body);
    }

    let check = model::device_allowed(&state.db, &row, &device_id, s.default_device_limit);
    if !check.allowed {
        model::log_event(&state.db, "activate-conflict", Some(&row.key), &ip, &device_id);
        return fail(
            StatusCode::CONFLICT,
            json!({
                "error": model::device_limit_message(&check),
                "deviceMismatch": true,
                "devices": { "used": check.used, "limit": check.limit },
            }),
        );
    }

    // The other direction: this machine already belongs to a different account.
    // Refused, never blocked — both accounts stay healthy on their own hardware.
    if let (Some(dev), Some(owner_email)) = (model::find_device(&state.db, &device_id), row.email.as_ref()) {
        if let Some(holder) = dev.email.filter(|e| !e.is_empty() && !e.eq_ignore_ascii_case(owner_email)) {
            model::log_event(&state.db, "activate-device-taken", Some(&row.key), &ip, &device_id);
            return fail(
                StatusCode::CONFLICT,
                json!({
                    "error": format!("This device is already registered to {}. One device, one account.", model::mask_email(&holder)),
                    "deviceTaken": true,
                }),
            );
        }
    }

    model::bind_device(&state.db, &row, &device_id, &device_name);
    model::log_event(
        &state.db,
        if check.known { "reactivate" } else { "activate" },
        Some(&row.key),
        &ip,
        &device_name,
    );

    let fresh = model::find_key(&state.db, &row.key).unwrap_or(row);
    let token = match state.tokens.issue(&fresh.key, &device_id, fresh.email.as_deref()) {
        Some(t) => t,
        None => return error(StatusCode::INTERNAL_SERVER_ERROR, "could not issue a token"),
    };

    let mut payload = account_payload(&state, &fresh);
    if let Some(map) = payload.as_object_mut() {
        map.insert("token".into(), json!(token));
        map.insert("email".into(), json!(fresh.email.clone().unwrap_or_default()));
        map.insert("expiresIn".into(), json!(state.tokens.ttl_seconds()));
    }
    (StatusCode::OK, ok(payload)).into_response_pair()
}

// ------------------------------------------------------------- heartbeat

#[derive(Deserialize)]
pub struct HeartbeatBody {
    #[serde(default)]
    token: String,
}

async fn heartbeat(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<HeartbeatBody>,
) -> impl IntoResponse {
    let ip = client_ip(&headers);
    if body.token.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "missing token");
    }
    let claims = match state.tokens.verify(body.token.trim()) {
        Some(c) => c,
        None => return error(StatusCode::UNAUTHORIZED, "invalid token"),
    };
    let row = match model::find_key(&state.db, &claims.key) {
        Some(row) => row,
        None => return error(StatusCode::NOT_FOUND, "unknown key"),
    };

    // A refused licence still carries the pricing and the notices: someone
    // whose licence just expired is the one person most worth making an offer
    // to, and the lock screen is the only surface they can act on.
    if let Some((status, mut body)) = refuse_state(model::state_of(&row)) {
        model::log_event(&state.db, "heartbeat-refused", Some(&row.key), &ip, &claims.device_id);
        let trial_left = model::trial_remaining(&state.db, &row, settings(&state).trial_downloads);
        if let Some(map) = body.as_object_mut() {
            map.insert("plans".into(), json!(model::public_plans(&state.db)));
            map.insert("notices".into(), json!(model::notices_for(&state.db, &row, trial_left)));
        }
        return fail(status, body);
    }

    // Membership, not identity: a key may legitimately run on several machines,
    // and an admin unbinding one is what takes it away again.
    if !claims.device_id.is_empty() && !model::bound_devices(&state.db, &row).contains(&claims.device_id) {
        return error(StatusCode::CONFLICT, "device mismatch");
    }

    model::touch_heartbeat(&state.db, &row.key);
    // Rotated on every beat, so a leaked token is superseded within one
    // interval rather than lasting as long as the licence.
    let token = match state.tokens.issue(&row.key, &claims.device_id, row.email.as_deref()) {
        Some(t) => t,
        None => return error(StatusCode::INTERNAL_SERVER_ERROR, "could not issue a token"),
    };

    let mut payload = account_payload(&state, &row);
    if let Some(map) = payload.as_object_mut() {
        map.insert("token".into(), json!(token));
        map.insert("revoked".into(), json!(false));
        map.insert("blocked".into(), json!(false));
        map.insert("expired".into(), json!(false));
    }
    (StatusCode::OK, ok(payload)).into_response_pair()
}

// ----------------------------------------------------------------- plans

/// The published pricing, open to anyone: the website shows it and a visitor
/// has no licence to authenticate with. It carries only what an admin ticked
/// Published, which is exactly what a website is for.
async fn plans(State(state): State<Shared>) -> impl IntoResponse {
    (
        [(axum::http::header::CACHE_CONTROL, "public, max-age=60")],
        ok(json!({ "plans": model::public_plans(&state.db) })),
    )
}

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/signup", post(signup))
        .route("/api/activate", post(activate))
        .route("/api/heartbeat", post(heartbeat))
        .route("/api/plans", get(plans))
}

/// Lets a handler return either `ok(...)` or `fail(...)` from the same
/// function without spelling out a shared error type at every branch.
trait IntoPair {
    fn into_response_pair(self) -> (StatusCode, Json<Value>);
}

impl IntoPair for (StatusCode, Json<Value>) {
    fn into_response_pair(self) -> (StatusCode, Json<Value>) {
        self
    }
}
