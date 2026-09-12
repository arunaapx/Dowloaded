//! The three calls the desktop app makes, and the one the website makes.
//!
//! These only translate HTTP: read the body, ask `model` what the rules say,
//! answer in the shape the app already parses. Every decision — who may
//! activate, how many machines, what a trial has left, which notice reaches
//! whom — lives in `model`, where it can be tested without a socket.

use crate::{
    auth::Tokens,
    cookies::Jar,
    db::Db,
    extract::{Extractor, Selection},
    gate::{self, DailyUsage},
    limit::Limits,
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
    pub extractor: Extractor,
    /// The per-key daily ceiling, kept in memory: it is a rate limit, not a
    /// record, and it clears itself at midnight.
    pub usage: DailyUsage,
    /// The YouTube cookie jar: one file, treated as a password. The admin
    /// panel manages it and the extractor uses it.
    pub jar: Jar,
    /// Sign-in, sign-up, activation and heartbeat limits, per address.
    pub limits: Limits,
    pub admin_user: String,
    pub admin_pass: String,
    /// The shared secret the store service calls /internal/issue-key with.
    /// Empty means that route is switched off entirely.
    pub internal_token: String,
    pub trial_downloads: i64,
    pub default_license_days: i64,
    pub default_device_limit: i64,
    pub signup_per_hour: i64,
    pub started: std::time::Instant,
}

pub type Shared = Arc<AppState>;

// --------------------------------------------------------------- helpers

pub(crate) fn ok(mut payload: Value) -> Json<Value> {
    if let Some(map) = payload.as_object_mut() {
        map.insert("ok".into(), Value::Bool(true));
    }
    Json(payload)
}

pub(crate) fn fail(status: StatusCode, payload: Value) -> (StatusCode, Json<Value>) {
    let mut body = payload;
    if let Some(map) = body.as_object_mut() {
        map.insert("ok".into(), Value::Bool(false));
    }
    (status, Json(body))
}

pub(crate) fn error(status: StatusCode, message: &str) -> (StatusCode, Json<Value>) {
    fail(status, json!({ "error": message }))
}

/// The address a request came from, honouring the proxy in front of us — the
/// server only ever sees 127.0.0.1 otherwise, which would put every customer in
/// the world on one line of the audit log.
pub(crate) fn client_ip(headers: &HeaderMap) -> String {
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
///
/// The flags are not the same at every door, and that is deliberate rather than
/// untidy: the app's lock screen reads them, and it was written against these
/// exact bodies. `revoked` is only sent on the heartbeat, because that is the
/// one the running app polls; sign-up and activation say it in the message.
fn refuse_state(state_of: model::State) -> Option<(StatusCode, Value)> {
    match state_of {
        model::State::Revoked => Some((StatusCode::FORBIDDEN, json!({ "error": "key revoked" }))),
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

    // Sign-ups per hour per address. Mobile carriers put hundreds of real
    // customers behind one address, so the cap is generous and an operator can
    // switch it off; the one-account-per-machine lock is what actually limits
    // how many keys anyone can get.
    if let Err(minutes) = state.limits.signup.check(
        &ip,
        model::signup_per_hour(&state.db, state.signup_per_hour),
    ) {
        model::log_event(&state.db, "rate-limited", None, &ip, "/api/signup");
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            json!({
                "error": "Too many sign-up attempts from this network. Please wait a while, or paste a key you already have.",
                "rateLimited": true,
                "retryAfterMinutes": minutes,
            }),
        );
    }

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

    if let Err(minutes) = state.limits.activate.check(&ip, state.limits.activate_max) {
        model::log_event(&state.db, "rate-limited", None, &ip, "/api/activate");
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            json!({
                "error": "Too many activation attempts. Please wait a minute and try again.",
                "rateLimited": true,
                "retryAfterMinutes": minutes,
            }),
        );
    }

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
    if let Err(minutes) = state.limits.heartbeat.check(&ip, state.limits.heartbeat_max) {
        model::log_event(&state.db, "rate-limited", None, &ip, "/api/heartbeat");
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            json!({
                "error": "Too many requests. Please wait a minute.",
                "rateLimited": true,
                "retryAfterMinutes": minutes,
            }),
        );
    }
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

    // Only these three are a refusal. A key that was issued and never used on a
    // machine is Pending, and belongs in the membership check further down - it is
    // not expired, and telling its owner it was would send them to the shop to buy
    // a licence they already hold.
    let refusal = match model::state_of(&row) {
        model::State::Revoked => Some(("heartbeat-revoked", json!({ "error": "key revoked", "revoked": true }), false)),
        model::State::Blocked => Some(("heartbeat-blocked", json!({ "error": "user blocked", "blocked": true }), false)),
        model::State::Expired => Some(("heartbeat-expired", json!({ "error": "license expired", "expired": true }), true)),
        _ => None,
    };
    if let Some((kind, mut body, offer)) = refusal {
        model::log_event(&state.db, kind, Some(&row.key), &ip, &claims.device_id);
        // An expired licence — and only an expired one — is sent the pricing and
        // the notices with the refusal. Someone whose subscription just ran out
        // is the person most worth making an offer to, and the lock screen is the
        // only surface they can act on. A revoked or blocked licence is one
        // somebody took away on purpose; it gets no sales pitch.
        if offer {
            let trial_left = model::trial_remaining(&state.db, &row, settings(&state).trial_downloads);
            if let Some(map) = body.as_object_mut() {
                map.insert("plans".into(), json!(model::public_plans(&state.db)));
                map.insert("notices".into(), json!(model::notices_for(&state.db, &row, trial_left)));
            }
        }
        return fail(StatusCode::FORBIDDEN, body);
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

// --------------------------------------------------------- gated routes
//
// Everything below asks the extractor something, so everything below goes
// through the gates first: a valid token for an active key on one of its
// machines, the day's ceiling, and the trial's own count.

#[derive(Deserialize, Default)]
pub struct GatedBody {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    quality: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default, rename = "vCodec")]
    vcodec: Option<String>,
    #[serde(default, rename = "aFormat")]
    aformat: Option<String>,
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok())
}

/// The first two gates, which every gated route needs, plus the burst limit in
/// front of them.
///
/// The daily cap is about one licence being resold; this is about one address
/// hammering the extractor, which costs the server real work per request whether
/// the licence is honest or not.
fn admit(
    state: &AppState,
    headers: &HeaderMap,
    token: Option<&String>,
) -> Result<(gate::Licence, String), (StatusCode, Json<Value>)> {
    let ip = client_ip(headers);
    if let Err(minutes) = state.limits.extract.check(&ip, state.limits.extract_max) {
        return Err(fail(
            StatusCode::TOO_MANY_REQUESTS,
            json!({
                "error": "Too many requests. Please wait a minute.",
                "rateLimited": true,
                "retryAfterMinutes": minutes,
            }),
        ));
    }
    let licence = gate::require_licence(state, bearer(headers), token.map(String::as_str))?;
    gate::enforce_daily_cap(state, &licence, &ip)?;
    Ok((licence, ip))
}

/// Called once before each download by the app that does its own downloading.
/// It spends the credit; the bytes never come near the server.
async fn authorize(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<GatedBody>,
) -> impl IntoResponse {
    let (licence, ip) = match admit(&state, &headers, body.token.as_ref()) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let cap = settings(&state).trial_downloads;
    let remaining = match gate::enforce_trial(&state, &licence, &ip, cap) {
        Ok(r) => r,
        Err(e) => return e,
    };

    gate::spend_download(&state, &licence);
    model::log_event(
        &state.db,
        "authorize",
        Some(&licence.key.key),
        &ip,
        if licence.key.trial { "trial" } else { "paid" },
    );
    (
        StatusCode::OK,
        ok(json!({
            "trial": licence.key.trial,
            "trialRemaining": remaining.map(|r| (r - 1).max(0)),
        })),
    )
}

/// Read a link: what it is, and the options to offer for it. No credit is spent
/// — someone pasting a link has not downloaded anything yet.
async fn extract(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<GatedBody>,
) -> impl IntoResponse {
    let (licence, ip) = match admit(&state, &headers, body.token.as_ref()) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let cap = settings(&state).trial_downloads;
    // Refused early for a spent trial, so the wall appears on paste rather than
    // after the customer has chosen a quality.
    if let Err(e) = gate::enforce_trial(&state, &licence, &ip, cap) {
        return e;
    }

    let info = state.extractor.probe(body.url.as_deref().unwrap_or_default()).await;
    if info["ok"] != json!(true) {
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(info));
    }
    model::log_event(
        &state.db,
        "extract",
        Some(&licence.key.key),
        &ip,
        info["meta"]["extractor"].as_str().unwrap_or_default(),
    );
    (StatusCode::OK, Json(info))
}

/// Turn a chosen option into the URLs the client fetches. This is the one that
/// counts as a download.
async fn resolve(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<GatedBody>,
) -> impl IntoResponse {
    let (licence, ip) = match admit(&state, &headers, body.token.as_ref()) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let cap = settings(&state).trial_downloads;
    if let Err(e) = gate::enforce_trial(&state, &licence, &ip, cap) {
        return e;
    }

    let out = state
        .extractor
        .resolve(
            body.url.as_deref().unwrap_or_default(),
            &Selection {
                mode: body.mode.clone(),
                quality: body.quality.clone(),
                vcodec: body.vcodec.clone(),
                aformat: body.aformat.clone(),
            },
        )
        .await;
    if out["ok"] != json!(true) {
        // Nothing is spent on a link that could not be resolved.
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(out));
    }

    gate::spend_download(&state, &licence);
    model::log_event(
        &state.db,
        "resolve",
        Some(&licence.key.key),
        &ip,
        &format!("{}/{}", out["mode"].as_str().unwrap_or("video"), body.quality.clone().unwrap_or_default()),
    );
    (StatusCode::OK, Json(out))
}

async fn search(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<GatedBody>,
) -> impl IntoResponse {
    if let Err(e) = admit(&state, &headers, body.token.as_ref()) {
        return e;
    }
    let out = state.extractor.search(body.query.as_deref().unwrap_or_default(), body.limit).await;
    let status = if out["ok"] == json!(true) { StatusCode::OK } else { StatusCode::UNPROCESSABLE_ENTITY };
    (status, Json(out))
}

async fn extractors(
    State(state): State<Shared>,
    headers: HeaderMap,
    body: Option<Json<GatedBody>>,
) -> impl IntoResponse {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    if let Err(e) = admit(&state, &headers, body.token.as_ref()) {
        return e;
    }
    let out = state.extractor.list_sites().await;
    let status = if out["ok"] == json!(true) { StatusCode::OK } else { StatusCode::UNPROCESSABLE_ENTITY };
    (status, Json(out))
}

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/signup", post(signup))
        .route("/api/activate", post(activate))
        .route("/api/heartbeat", post(heartbeat))
        .route("/api/plans", get(plans))
        .route("/api/authorize", post(authorize))
        .route("/api/extract", post(extract))
        .route("/api/resolve", post(resolve))
        .route("/api/search", post(search))
        .route("/api/extractors", post(extractors))
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
