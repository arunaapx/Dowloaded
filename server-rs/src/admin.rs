//! The admin panel's API.
//!
//! Twenty-six routes behind one session cookie. The panel's HTML and JS are the
//! Node server's, unported and unchanged, so every answer here has to match the
//! shape it already reads — field names included, `created_at` and all.
//!
//! Two rules run through the whole file:
//!
//!   * **Nothing destructive happens by accident.** Forgiving a trial, moving an
//!     account and deleting a machine are three separate routes, because they
//!     are three different decisions.
//!   * **Every change is written to the audit log** with the address it came
//!     from. When a customer says their licence stopped working, the log is the
//!     only thing that can say what happened to it.

use crate::{
    auth::ADMIN_TTL_SECONDS,
    model::{self, NoticeRow, PlanRow},
    routes::{client_ip, error, fail, ok, Shared},
};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub const ADMIN_COOKIE: &str = "velox_admin";

type Answer = (StatusCode, Json<Value>);

// ------------------------------------------------------------------ session

/// The session cookie. HttpOnly so a cross-site script cannot read it,
/// SameSite=Strict so another site cannot make the browser use it, and Secure
/// once there is TLS in front — which there is in production and is not on a
/// developer's machine.
fn set_cookie(token: &str) -> String {
    let mut flags = format!("{ADMIN_COOKIE}={token}; Path=/; Max-Age={ADMIN_TTL_SECONDS}; HttpOnly; SameSite=Strict");
    if std::env::var("NODE_ENV").as_deref() == Ok("production") {
        flags.push_str("; Secure");
    }
    flags
}

fn clear_cookie() -> String {
    format!("{ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
}

pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (k, v) = part.split_once('=')?;
        (k.trim() == name).then(|| v.trim().to_string())
    })
}

/// Is whoever sent this request signed in to the panel?
pub fn signed_in(state: &Shared, headers: &HeaderMap) -> bool {
    cookie_value(headers, ADMIN_COOKIE)
        .and_then(|token| state.tokens.verify_admin(&token))
        .is_some()
}

/// Every route below starts with this. An expired session is told so, rather
/// than being handed an empty table that looks like a server with no customers.
fn require_admin(state: &Shared, headers: &HeaderMap) -> Result<(), Answer> {
    if signed_in(state, headers) {
        return Ok(());
    }
    Err(error(StatusCode::UNAUTHORIZED, "unauthorized"))
}

#[derive(Deserialize)]
pub struct LoginBody {
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
}

async fn login(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<LoginBody>) -> Response {
    let ip = client_ip(&headers);
    // Ten attempts per address per fifteen minutes. This is the only thing
    // standing between the panel password and an unlimited number of guesses.
    if let Err(minutes) = state.limits.login.check(&ip, state.limits.login_max) {
        model::log_event(&state.db, "admin-login-throttled", None, &ip, &body.username);
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            json!({
                "error": "Too many sign-in attempts. Please wait 15 minutes.",
                "rateLimited": true,
                "retryAfterMinutes": minutes,
            }),
        )
        .into_response();
    }

    if state.admin_pass.is_empty() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "ADMIN_PASS not set on server").into_response();
    }
    let user_ok = constant_time_eq(body.username.trim(), &state.admin_user);
    let pass_ok = constant_time_eq(&body.password, &state.admin_pass);
    if !(user_ok && pass_ok) {
        // Which half was wrong is not said: it would confirm the username.
        model::log_event(&state.db, "admin-login-fail", None, &ip, body.username.trim());
        return error(StatusCode::UNAUTHORIZED, "invalid credentials").into_response();
    }

    let token = match state.tokens.issue_admin(body.username.trim()) {
        Some(t) => t,
        None => return error(StatusCode::INTERNAL_SERVER_ERROR, "could not start a session").into_response(),
    };
    model::log_event(&state.db, "admin-login", None, &ip, body.username.trim());
    ([(header::SET_COOKIE, set_cookie(&token))], ok(json!({}))).into_response()
}

async fn logout() -> Response {
    ([(header::SET_COOKIE, clear_cookie())], ok(json!({}))).into_response()
}

/// Compares in time that does not depend on how much of the string matched, so
/// the answer cannot be used to guess the password one character at a time.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

// ------------------------------------------------------------------ helpers

fn settings_now(state: &Shared) -> model::Settings {
    model::settings(
        &state.db,
        (state.trial_downloads, state.default_license_days, state.default_device_limit),
    )
}

fn keys_payload(state: &Shared) -> Value {
    let s = settings_now(state);
    json!({ "keys": model::admin_keys(&state.db, s.trial_downloads, s.default_device_limit) })
}

fn one_key(state: &Shared, key: &str) -> Value {
    let s = settings_now(state);
    model::admin_key(&state.db, key, s.trial_downloads, s.default_device_limit).unwrap_or(Value::Null)
}

/// How long a licence lasts, in days. Blank means the default; 0 means forever.
/// `None` means the operator typed something that is not a number of days.
fn parse_days(v: Option<&Value>, fallback: i64) -> Option<i64> {
    match v {
        None | Some(Value::Null) => Some(fallback),
        Some(Value::String(s)) if s.trim().is_empty() => Some(fallback),
        Some(value) => {
            let n = value.as_f64().or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))?;
            (n.is_finite() && (0.0..=36_500.0).contains(&n)).then_some(n.floor() as i64)
        }
    }
}

fn expires_from_days(days: i64) -> Option<i64> {
    (days > 0).then(|| model::now_ms() + days * model::DAY_MS)
}

/// An expiry date as the panel sends it: a timestamp, a date string, or blank
/// for a licence that does not expire. `Err` means it was none of those, which
/// has to be refused rather than silently read as "never".
fn parse_expires_at(v: Option<&Value>) -> Result<Option<i64>, ()> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64().filter(|n| *n > 0.0).map(|n| n as i64)),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                return Ok(None);
            }
            if let Ok(n) = s.parse::<f64>() {
                return Ok((n > 0.0).then_some(n as i64));
            }
            parse_date(s).map(Some).ok_or(())
        }
        Some(_) => Err(()),
    }
}

/// `YYYY-MM-DD`, optionally with a time — what a date input sends. Read as UTC,
/// the way the rest of the ledger counts.
fn parse_date(s: &str) -> Option<i64> {
    let (date, time) = s.split_once(['T', ' ']).unwrap_or((s, ""));
    let mut parts = date.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let days = days_from_civil(y, m, d);

    let mut secs = 0i64;
    let time = time.trim_end_matches('Z');
    if !time.is_empty() {
        let mut t = time.split(':');
        let h: i64 = t.next().unwrap_or("0").parse().unwrap_or(0);
        let min: i64 = t.next().unwrap_or("0").parse().unwrap_or(0);
        let sec: i64 = t.next().unwrap_or("0").split('.').next().unwrap_or("0").parse().unwrap_or(0);
        secs = h * 3600 + min * 60 + sec;
    }
    Some((days * 86_400 + secs) * 1000)
}

/// The inverse of the one in `model`, and from the same paper.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn trimmed(v: Option<&Value>, max: usize) -> String {
    v.and_then(Value::as_str).unwrap_or_default().trim().chars().take(max).collect()
}

// -------------------------------------------------------------------- keys

async fn list_keys(State(state): State<Shared>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    (StatusCode::OK, ok(keys_payload(&state)))
}

async fn list_events(State(state): State<Shared>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    (StatusCode::OK, ok(json!({ "events": model::recent_events(&state.db, 200) })))
}

async fn create_key(State(state): State<Shared>, headers: HeaderMap, body: Option<Json<Value>>) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let body = body.map(|Json(b)| b).unwrap_or(json!({}));
    let email = trimmed(body.get("email"), 200).to_lowercase();
    let note = {
        let n = trimmed(body.get("note"), 200);
        if n.is_empty() { "admin-created".to_string() } else { n }
    };
    if !email.is_empty() && !model::email_ok(&email) {
        return error(StatusCode::BAD_REQUEST, "invalid email");
    }
    let days = match parse_days(body.get("days"), settings_now(&state).default_license_days) {
        Some(d) => d,
        None => return error(StatusCode::BAD_REQUEST, "invalid license days"),
    };

    let key = model::make_key();
    let expires_at = expires_from_days(days);
    // A key made here is a paid one: an admin handing someone a licence is not
    // handing them a trial with a download cap.
    if model::insert_key(&state.db, &key, (!email.is_empty()).then_some(email.as_str()), &note, expires_at, false)
        .is_err()
    {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "could not create a key");
    }
    model::log_event(
        &state.db,
        "admin-create",
        Some(&key),
        &client_ip(&headers),
        &format!("{} / {} days", if email.is_empty() { "no-email" } else { &email }, if days == 0 { "lifetime".to_string() } else { days.to_string() }),
    );
    (StatusCode::OK, ok(json!({ "key": key, "expiresAt": expires_at, "keys": keys_payload(&state)["keys"] })))
}

async fn update_key(
    State(state): State<Shared>,
    Path(key): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let body = body.map(|Json(b)| b).unwrap_or(json!({}));
    let key = model::normalize_key(&key);
    let row = match model::find_key(&state.db, &key) {
        Some(r) => r,
        None => return error(StatusCode::NOT_FOUND, "unknown key"),
    };

    let email = trimmed(body.get("email"), 200).to_lowercase();
    let note = trimmed(body.get("note"), 200);
    if !email.is_empty() && !model::email_ok(&email) {
        return error(StatusCode::BAD_REQUEST, "invalid email");
    }
    let expires_at = match parse_expires_at(body.get("expiresAt")) {
        Ok(v) => v,
        Err(()) => return error(StatusCode::BAD_REQUEST, "invalid expiry date"),
    };

    // The allowance, when the panel sent one. Blank means "follow the plan",
    // which is what most keys should do.
    if let Some(raw) = body.get("deviceLimit") {
        match raw {
            Value::Null => model::set_key_device_limit(&state.db, &key, None),
            Value::String(s) if s.trim().is_empty() => model::set_key_device_limit(&state.db, &key, None),
            other => {
                let n = other.as_f64().or_else(|| other.as_str().and_then(|s| s.trim().parse().ok()));
                match n.filter(|n| n.is_finite() && (1.0..=20.0).contains(n)) {
                    Some(n) => model::set_key_device_limit(&state.db, &key, Some(n.floor() as i64)),
                    None => {
                        return error(
                            StatusCode::BAD_REQUEST,
                            "devices must be between 1 and 20, or blank to follow the plan",
                        )
                    }
                }
            }
        };
    }
    if let Some(raw) = body.get("plan") {
        let plan = raw.as_str().unwrap_or_default().trim().to_string();
        if !plan.is_empty() && !model::plan_exists(&state.db, &plan) {
            return error(StatusCode::BAD_REQUEST, "unknown plan");
        }
        model::set_key_plan(&state.db, &key, (!plan.is_empty()).then_some(plan.as_str()));
    }

    let changed = model::update_key(
        &state.db,
        &key,
        (!email.is_empty()).then_some(email.as_str()),
        (!note.is_empty()).then_some(note.as_str()),
        expires_at,
    );

    // Keep the hardware ledger in step: changing an address in the panel is the
    // supported way to move an account, so the machines follow it or the old
    // address keeps the lock.
    if !email.is_empty() && !email.eq_ignore_ascii_case(row.email.as_deref().unwrap_or_default()) {
        model::set_devices_email(&state.db, &key, &email);
    }
    model::log_event(
        &state.db,
        "admin-update",
        Some(&key),
        &client_ip(&headers),
        &format!(
            "{} / {}",
            if email.is_empty() { "no-email" } else { &email },
            expires_at.map(|e| e.to_string()).unwrap_or_else(|| "lifetime".into())
        ),
    );
    (StatusCode::OK, ok(json!({ "changed": changed, "key": one_key(&state, &key) })))
}

async fn extend_key(
    State(state): State<Shared>,
    Path(key): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let body = body.map(|Json(b)| b).unwrap_or(json!({}));
    let key = model::normalize_key(&key);
    let row = match model::find_key(&state.db, &key) {
        Some(r) => r,
        None => return error(StatusCode::NOT_FOUND, "unknown key"),
    };
    let days = match parse_days(body.get("days"), 30).filter(|d| *d > 0) {
        Some(d) => d,
        None => return error(StatusCode::BAD_REQUEST, "invalid extension days"),
    };

    // Extending a licence that has not run out adds to what is left; one that
    // has already lapsed starts again from today, so nobody pays for time they
    // could not use.
    let base = row.expires_at.filter(|e| *e > model::now_ms()).unwrap_or_else(model::now_ms);
    let expires_at = base + days * model::DAY_MS;
    let changed = model::update_key(&state.db, &key, row.email.as_deref(), row.note.as_deref(), Some(expires_at));
    model::log_event(&state.db, "admin-extend", Some(&key), &client_ip(&headers), &format!("{days} days"));
    (StatusCode::OK, ok(json!({ "changed": changed, "key": one_key(&state, &key) })))
}

async fn make_paid(State(state): State<Shared>, Path(key): Path<String>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let key = model::normalize_key(&key);
    let row = match model::find_key(&state.db, &key) {
        Some(r) => r,
        None => return error(StatusCode::NOT_FOUND, "unknown key"),
    };
    let changed = model::set_key_paid(&state.db, &key);
    model::log_event(
        &state.db,
        "admin-make-paid",
        Some(&key),
        &client_ip(&headers),
        row.email.as_deref().unwrap_or_default(),
    );
    (StatusCode::OK, ok(json!({ "changed": changed, "key": one_key(&state, &key) })))
}

async fn block_key(
    State(state): State<Shared>,
    Path(key): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let body = body.map(|Json(b)| b).unwrap_or(json!({}));
    let key = model::normalize_key(&key);
    let reason = trimmed(body.get("reason"), 200);
    let changed = model::block_key(&state.db, &key, &reason);
    model::log_event(&state.db, "admin-block", Some(&key), &client_ip(&headers), &reason);
    (StatusCode::OK, ok(json!({ "changed": changed })))
}

async fn unblock_key(State(state): State<Shared>, Path(key): Path<String>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let key = model::normalize_key(&key);
    let changed = model::unblock_key(&state.db, &key);
    model::log_event(&state.db, "admin-unblock", Some(&key), &client_ip(&headers), "");
    (StatusCode::OK, ok(json!({ "changed": changed })))
}

async fn revoke_key(State(state): State<Shared>, Path(key): Path<String>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let key = model::normalize_key(&key);
    let changed = model::set_key_revoked(&state.db, &key, true);
    model::log_event(&state.db, "admin-revoke", Some(&key), &client_ip(&headers), "");
    (StatusCode::OK, ok(json!({ "changed": changed })))
}

async fn unrevoke_key(State(state): State<Shared>, Path(key): Path<String>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let key = model::normalize_key(&key);
    let changed = model::set_key_revoked(&state.db, &key, false);
    model::log_event(&state.db, "admin-unrevoke", Some(&key), &client_ip(&headers), "");
    (StatusCode::OK, ok(json!({ "changed": changed })))
}

/// The only way a customer moves to new hardware.
async fn reset_device(State(state): State<Shared>, Path(key): Path<String>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let key = model::normalize_key(&key);
    let (changed, unbound) = model::reset_key_devices(&state.db, &key);
    model::log_event(
        &state.db,
        "admin-reset-device",
        Some(&key),
        &client_ip(&headers),
        &format!("unbound {unbound} device(s)"),
    );
    (StatusCode::OK, ok(json!({ "changed": changed, "unboundDevices": unbound })))
}

async fn delete_key(State(state): State<Shared>, Path(key): Path<String>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let key = model::normalize_key(&key);
    let changed = model::delete_key(&state.db, &key);
    model::log_event(&state.db, "admin-delete", Some(&key), &client_ip(&headers), "");
    (StatusCode::OK, ok(json!({ "changed": changed })))
}

// ----------------------------------------------------------------- devices

async fn list_devices(State(state): State<Shared>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let cap = settings_now(&state).trial_downloads;
    (
        StatusCode::OK,
        ok(json!({ "devices": model::all_devices(&state.db, cap), "trialCap": cap })),
    )
}

async fn reset_device_trial(State(state): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let id = id.trim().to_string();
    let changed = model::reset_device_trial(&state.db, &id);
    model::log_event(&state.db, "admin-device-reset-trial", None, &client_ip(&headers), short(&id));
    (StatusCode::OK, ok(json!({ "changed": changed })))
}

async fn unbind_device(State(state): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let id = id.trim().to_string();
    let was_on = model::detach_device_from_key(&state.db, &id);
    let changed = model::clear_device_binding(&state.db, &id);
    model::log_event(&state.db, "admin-device-unbind", was_on.as_deref(), &client_ip(&headers), short(&id));
    (StatusCode::OK, ok(json!({ "changed": changed })))
}

async fn delete_device(State(state): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let id = id.trim().to_string();
    let was_on = model::detach_device_from_key(&state.db, &id);
    let changed = model::delete_device(&state.db, &id);
    model::log_event(&state.db, "admin-device-delete", was_on.as_deref(), &client_ip(&headers), short(&id));
    (StatusCode::OK, ok(json!({ "changed": changed })))
}

/// A machine id is a hash, and the log is read by people. The head of it is
/// enough to match a row in the table.
fn short(id: &str) -> &str {
    &id[..id.len().min(16)]
}

// ---------------------------------------------------------------- settings

async fn get_settings(State(state): State<Shared>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    (StatusCode::OK, ok(json!({ "settings": settings_json(&state) })))
}

fn settings_json(state: &Shared) -> Value {
    let s = settings_now(state);
    json!({
        "signupEnabled": s.signup_enabled,
        "trialDownloads": s.trial_downloads,
        "defaultLicenseDays": s.default_license_days,
        "defaultDeviceLimit": s.default_device_limit,
        "signupPerHour": model::signup_per_hour(&state.db, state.signup_per_hour),
    })
}

async fn save_settings(State(state): State<Shared>, headers: HeaderMap, body: Option<Json<Value>>) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let body = body.map(|Json(b)| b).unwrap_or(json!({}));
    let mut patch: Vec<(&str, Value)> = Vec::new();

    if let Some(v) = body.get("signupEnabled") {
        patch.push(("signupEnabled", json!(truthy(v))));
    }
    // Each range is the range that makes sense for the thing, and a value
    // outside it is refused rather than clamped: an operator who typed 100000
    // free downloads meant something, and quietly storing 10000 would hide it.
    for (field, min, max, message) in [
        ("trialDownloads", 1.0, 10_000.0, "trial downloads must be between 1 and 10000"),
        ("defaultLicenseDays", 0.0, 36_500.0, "default days must be between 0 and 36500"),
        ("defaultDeviceLimit", 1.0, 20.0, "devices per key must be between 1 and 20"),
        ("signupPerHour", 0.0, 100_000.0, "sign-ups per hour must be between 0 and 100000 (0 = no limit)"),
    ] {
        if let Some(v) = body.get(field) {
            let n = v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()));
            match n.filter(|n| n.is_finite() && *n >= min && *n <= max) {
                Some(n) => patch.push((field, json!(n.floor() as i64))),
                None => return error(StatusCode::BAD_REQUEST, message),
            }
        }
    }

    for (name, value) in &patch {
        let _ = state.db.set_setting(name, value);
    }
    let detail = Value::Object(patch.into_iter().map(|(k, v)| (k.to_string(), v)).collect());
    model::log_event(&state.db, "admin-settings", None, &client_ip(&headers), &detail.to_string());
    (StatusCode::OK, ok(json!({ "settings": settings_json(&state) })))
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(s) => !matches!(s.trim().to_lowercase().as_str(), "" | "false" | "0" | "off" | "no"),
        _ => false,
    }
}

// ------------------------------------------------------------------- plans

/// The periods a price may be quoted in. A free-text period would end up with
/// "per moth" on the website.
const PLAN_PERIODS: [&str; 5] = ["", "one time", "per month", "per year", "per week"];

async fn get_plans(State(state): State<Shared>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    (StatusCode::OK, ok(json!({ "plans": model::all_plans(&state.db), "periods": PLAN_PERIODS })))
}

async fn post_plans(State(state): State<Shared>, headers: HeaderMap, body: Option<Json<Value>>) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let body = body.map(|Json(b)| b).unwrap_or(json!({}));
    let input = match body.get("plans").and_then(Value::as_array) {
        Some(list) => list,
        None => return error(StatusCode::BAD_REQUEST, "plans must be a list"),
    };
    if input.len() > 20 {
        return error(StatusCode::BAD_REQUEST, "at most 20 plans");
    }

    let mut plans: Vec<PlanRow> = Vec::new();
    for (i, p) in input.iter().enumerate() {
        let name = trimmed(p.get("name"), 60);
        if name.is_empty() {
            return error(StatusCode::BAD_REQUEST, &format!("plan {} needs a name", i + 1));
        }
        // An id nobody typed is made from the name, so the panel can add a plan
        // without asking an operator to invent a slug.
        let id = {
            let given = trimmed(p.get("id"), 40);
            if given.is_empty() {
                slugify(&name)
            } else {
                given
            }
        };
        if plans.iter().any(|existing| existing.id == id) {
            return error(StatusCode::BAD_REQUEST, &format!("two plans share the id \"{id}\""));
        }
        let period = trimmed(p.get("period"), 20);
        if !PLAN_PERIODS.contains(&period.as_str()) {
            return error(StatusCode::BAD_REQUEST, &format!("plan \"{name}\" has an unknown period"));
        }

        plans.push(PlanRow {
            id,
            name,
            price: trimmed(p.get("price"), 40),
            period,
            devices: p
                .get("devices")
                .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
                .map(|n| (n.floor() as i64).clamp(1, 20))
                .unwrap_or(1),
            features: p
                .get("features")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .map(|f| f.as_str().unwrap_or_default().trim().chars().take(120).collect::<String>())
                        .filter(|f| !f.is_empty())
                        .take(12)
                        .collect()
                })
                .unwrap_or_default(),
            highlight: p.get("highlight").map(truthy).unwrap_or(false),
            active: p.get("active").map(truthy).unwrap_or(false),
            buy_url: trimmed(p.get("buyUrl"), 300),
            order: p
                .get("order")
                .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
                .map(|n| n as i64)
                .unwrap_or(i as i64),
        });
    }

    if model::save_plans(&state.db, &plans).is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the plans");
    }
    model::log_event(
        &state.db,
        "admin-plans",
        None,
        &client_ip(&headers),
        &format!("{} plans", plans.len()),
    );
    (StatusCode::OK, ok(json!({ "plans": model::all_plans(&state.db) })))
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(40).collect()
}

// ----------------------------------------------------------------- notices

const NOTICE_AUDIENCES: [&str; 5] = ["all", "trial", "trial-exhausted", "paid", "expired"];
const NOTICE_LEVELS: [&str; 3] = ["info", "promo", "warn"];

/// A notice as an operator wrote it, or what is wrong with it.
fn read_notice(body: &Value) -> Result<NoticeRow, &'static str> {
    let title = trimmed(body.get("title"), 80);
    if title.is_empty() {
        return Err("a notice needs a title");
    }
    let audience = {
        let a = body.get("audience").and_then(Value::as_str).unwrap_or("all").to_string();
        if !NOTICE_AUDIENCES.contains(&a.as_str()) {
            return Err("unknown audience");
        }
        a
    };
    let level = {
        let l = body.get("level").and_then(Value::as_str).unwrap_or("info").to_string();
        if !NOTICE_LEVELS.contains(&l.as_str()) {
            return Err("unknown level");
        }
        l
    };
    let action_url = trimmed(body.get("actionUrl"), 300);
    // The app opens this in the customer's browser, so plain http (or worse, a
    // file: or javascript: URL) is refused here rather than on their machine.
    if !action_url.is_empty() && !action_url.to_lowercase().starts_with("https://") {
        return Err("the button link must start with https://");
    }

    Ok(NoticeRow {
        title,
        body: trimmed(body.get("body"), 400),
        audience,
        level,
        action_label: trimmed(body.get("actionLabel"), 40),
        action_url,
        active: body.get("active").map(truthy).unwrap_or(true),
    })
}

async fn get_notices(State(state): State<Shared>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    (
        StatusCode::OK,
        ok(json!({
            "notices": model::all_notices(&state.db),
            "audiences": NOTICE_AUDIENCES,
            "levels": NOTICE_LEVELS,
        })),
    )
}

async fn create_notice(State(state): State<Shared>, headers: HeaderMap, body: Option<Json<Value>>) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let body = body.map(|Json(b)| b).unwrap_or(json!({}));
    let notice = match read_notice(&body) {
        Ok(n) => n,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    if model::count_notices(&state.db) >= 100 {
        return error(StatusCode::BAD_REQUEST, "too many notices — delete some first");
    }

    let id = model::new_notice_id();
    if model::insert_notice(&state.db, &id, &notice).is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "could not save the notice");
    }
    model::log_event(
        &state.db,
        "admin-notice-new",
        None,
        &client_ip(&headers),
        &format!("{}: {}", notice.audience, notice.title),
    );
    (
        StatusCode::OK,
        ok(json!({
            "notice": model::find_notice(&state.db, &id),
            "notices": model::all_notices(&state.db),
        })),
    )
}

async fn edit_notice(
    State(state): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let body = body.map(|Json(b)| b).unwrap_or(json!({}));
    let existing = match model::find_notice(&state.db, &id) {
        Some(n) => n,
        None => return error(StatusCode::NOT_FOUND, "unknown notice"),
    };

    // Switching one on or off is the common edit, so it is allowed on its own —
    // the panel does not have to send a whole notice back to flip a switch.
    let only_active = body.as_object().map(|m| m.len() == 1 && m.contains_key("active")).unwrap_or(false);
    if only_active {
        let on = body.get("active").map(truthy).unwrap_or(false);
        model::set_notice_active(&state.db, &id, on);
        model::log_event(
            &state.db,
            "admin-notice-toggle",
            None,
            &client_ip(&headers),
            &format!("{id} -> {}", if on { "on" } else { "off" }),
        );
        return (StatusCode::OK, ok(json!({ "notices": model::all_notices(&state.db) })));
    }

    // Anything the edit did not mention keeps the value it had.
    let mut merged = existing;
    if let (Some(target), Some(patch)) = (merged.as_object_mut(), body.as_object()) {
        for (k, v) in patch {
            target.insert(k.clone(), v.clone());
        }
    }
    let notice = match read_notice(&merged) {
        Ok(n) => n,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    model::update_notice(&state.db, &id, &notice);
    model::log_event(&state.db, "admin-notice-edit", None, &client_ip(&headers), &id);
    (StatusCode::OK, ok(json!({ "notices": model::all_notices(&state.db) })))
}

async fn delete_notice(State(state): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    if model::delete_notice(&state.db, &id) == 0 {
        return error(StatusCode::NOT_FOUND, "unknown notice");
    }
    model::log_event(&state.db, "admin-notice-delete", None, &client_ip(&headers), &id);
    (StatusCode::OK, ok(json!({ "notices": model::all_notices(&state.db) })))
}

// ----------------------------------------------------------------- cookies

async fn get_cookies(State(state): State<Shared>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    (StatusCode::OK, ok(json!({ "cookies": state.jar.status() })))
}

/// A cookies.txt is not JSON and is bigger than the JSON cap, so this route
/// takes a text body of its own.
async fn post_cookies(State(state): State<Shared>, headers: HeaderMap, text: String) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    if text.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "Paste or upload a cookies.txt file.");
    }

    match state.jar.save(&text) {
        Err((message, problems)) => fail(
            StatusCode::BAD_REQUEST,
            json!({ "error": message, "problems": problems }),
        ),
        Ok(summary) => {
            // The extractor is pointed at the new jar at once: an upload that
            // only worked after a restart would look like it had not worked.
            state.extractor.set_cookies(state.jar.active_path());
            // Counts and dates only. A cookie name's value in the audit log
            // would put the credential somewhere it can be read back.
            model::log_event(
                &state.db,
                "yt-cookies-upload",
                None,
                &client_ip(&headers),
                &format!(
                    "{} session cookies, expires {}",
                    summary["session"],
                    summary["expiresAt"].as_str().unwrap_or("unknown")
                ),
            );
            (StatusCode::OK, ok(json!({ "cookies": state.jar.status() })))
        }
    }
}

async fn delete_cookies(State(state): State<Shared>, headers: HeaderMap) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    state.jar.clear();
    state.extractor.set_cookies(None);
    model::log_event(&state.db, "yt-cookies-clear", None, &client_ip(&headers), "");
    (StatusCode::OK, ok(json!({ "cookies": state.jar.status() })))
}

/// Do the cookies actually work? A jar can be perfectly well-formed and still be
/// signed out, and the only way to find out is to ask YouTube.
async fn test_cookies(State(state): State<Shared>, headers: HeaderMap, body: Option<Json<Value>>) -> Answer {
    if let Err(e) = require_admin(&state, &headers) {
        return e;
    }
    let body = body.map(|Json(b)| b).unwrap_or(json!({}));
    let url = {
        let given = trimmed(body.get("url"), 400);
        if given.is_empty() {
            "https://www.youtube.com/watch?v=aqz-KE-bpKQ".to_string()
        } else {
            given
        }
    };

    let started = std::time::Instant::now();
    let info = state.extractor.probe(&url).await;
    let took_ms = started.elapsed().as_millis() as i64;

    if info["ok"] != json!(true) {
        let message = info["error"].as_str().unwrap_or("extraction failed").to_lowercase();
        // The one failure worth naming: it means the jar is signed out, not that
        // the link is bad.
        let blocked = ["not a bot", "sign in to confirm", "login required"].iter().any(|m| message.contains(m));
        return (
            StatusCode::OK,
            ok(json!({
                "test": {
                    "passed": false,
                    "blocked": blocked,
                    "tookMs": took_ms,
                    "error": info["error"].as_str().unwrap_or("extraction failed").chars().take(400).collect::<String>(),
                }
            })),
        );
    }

    (
        StatusCode::OK,
        ok(json!({
            "test": {
                "passed": true,
                "tookMs": took_ms,
                "title": info["meta"]["title"],
                "uploader": info["meta"]["uploader"],
                "maxHeight": info["meta"]["maxHeight"],
                "qualities": info["videoOptions"].as_array().map(Vec::len).unwrap_or(0),
            }
        })),
    )
}

// ---------------------------------------------------------------- internal

/// Called by the store service the moment a payment is captured, so a buyer gets
/// their key on the thank-you screen instead of waiting for someone to make one
/// by hand.
///
/// Two independent guards: a shared token, and a hard loopback check, so it
/// stays unreachable from the internet even if nginx is ever misconfigured to
/// forward /internal.
async fn issue_key(
    State(state): State<Shared>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Answer {
    let body = body.map(|Json(b)| b).unwrap_or(json!({}));
    let ip = client_ip(&headers);
    if state.internal_token.is_empty() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "internal API disabled (VELOX_INTERNAL_TOKEN unset)",
        );
    }
    if !peer.ip().is_loopback() {
        model::log_event(&state.db, "internal-remote-attempt", None, &ip, "issue-key");
        return error(StatusCode::FORBIDDEN, "forbidden");
    }
    let supplied = headers.get("x-internal-token").and_then(|v| v.to_str().ok()).unwrap_or_default();
    if !constant_time_eq(supplied, &state.internal_token) {
        model::log_event(&state.db, "internal-auth-fail", None, &ip, "issue-key");
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    let email = trimmed(body.get("email"), 200).to_lowercase();
    if !model::email_ok(&email) {
        return error(StatusCode::BAD_REQUEST, "invalid email");
    }
    let days = match parse_days(body.get("days"), 0) {
        Some(d) => d,
        None => return error(StatusCode::BAD_REQUEST, "invalid license days"),
    };
    let note = {
        let n = trimmed(body.get("note"), 200);
        if n.is_empty() { "purchase".to_string() } else { n }
    };

    let key = model::make_key();
    let expires_at = expires_from_days(days);
    // Paid: no trial, no download cap.
    if model::insert_key(&state.db, &key, Some(&email), &note, expires_at, false).is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "could not create a key");
    }
    model::log_event(
        &state.db,
        "purchase-issue",
        Some(&key),
        &ip,
        &format!("{email} / {}", if days == 0 { "lifetime".to_string() } else { days.to_string() }),
    );
    (StatusCode::OK, ok(json!({ "key": key, "expiresAt": expires_at })))
}

// ------------------------------------------------------------------ router

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/admin-login", post(login))
        .route("/api/admin-logout", post(logout))
        .route("/internal/issue-key", post(issue_key))
        .route("/admin/api/keys", get(list_keys).post(create_key))
        .route(
            "/admin/api/keys/{key}",
            patch(update_key).delete(delete_key),
        )
        .route("/admin/api/keys/{key}/extend", post(extend_key))
        .route("/admin/api/keys/{key}/make-paid", post(make_paid))
        .route("/admin/api/keys/{key}/block", post(block_key))
        .route("/admin/api/keys/{key}/unblock", post(unblock_key))
        .route("/admin/api/keys/{key}/revoke", post(revoke_key))
        .route("/admin/api/keys/{key}/unrevoke", post(unrevoke_key))
        .route("/admin/api/keys/{key}/reset-device", post(reset_device))
        .route("/admin/api/events", get(list_events))
        .route("/admin/api/devices", get(list_devices))
        .route("/admin/api/devices/{id}", delete(delete_device))
        .route("/admin/api/devices/{id}/reset-trial", post(reset_device_trial))
        .route("/admin/api/devices/{id}/unbind", post(unbind_device))
        .route("/admin/api/settings", get(get_settings).post(save_settings))
        .route("/admin/api/plans", get(get_plans).post(post_plans))
        .route("/admin/api/notices", get(get_notices).post(create_notice))
        .route("/admin/api/notices/{id}", patch(edit_notice).delete(delete_notice))
        .route(
            "/admin/api/cookies",
            get(get_cookies).post(post_cookies).delete(delete_cookies),
        )
        .route("/admin/api/cookies/test", post(test_cookies))
}
