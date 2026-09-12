//! Who is allowed to ask the extractor anything.
//!
//! Three gates, in order, and a request reaches yt-dlp only through all three:
//!
//!   1. a valid token for an active key, on a machine that key is bound to;
//!   2. a per-key daily ceiling, so one licence cannot be resold as a free
//!      extraction API for a hundred people;
//!   3. the free trial's own count, which lives on the machine.
//!
//! A cracked client has no token and no extractor of its own, so it gets
//! nothing here. That is the whole point of the thin-client model: the part
//! worth stealing never ships.

use crate::{model, routes::AppState};
use axum::{http::StatusCode, Json};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Debug)]
pub struct Licence {
    pub key: model::Key,
    pub device_id: String,
}

type Refusal = (StatusCode, Json<Value>);

fn refuse(status: StatusCode, body: Value) -> Refusal {
    let mut body = body;
    if let Some(map) = body.as_object_mut() {
        map.insert("ok".into(), Value::Bool(false));
    }
    (status, Json(body))
}

/// Gate one: a token for an active key, on one of its machines.
pub fn require_licence(state: &AppState, bearer: Option<&str>, body_token: Option<&str>) -> Result<Licence, Refusal> {
    let token = bearer
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .or_else(|| body_token.map(str::trim).filter(|t| !t.is_empty()));

    let token = match token {
        Some(t) => t,
        None => return Err(refuse(StatusCode::UNAUTHORIZED, json!({ "error": "license required" }))),
    };
    let claims = match state.tokens.verify(token) {
        Some(c) => c,
        None => return Err(refuse(StatusCode::UNAUTHORIZED, json!({ "error": "invalid or expired token" }))),
    };
    let key = match model::find_key(&state.db, &claims.key) {
        Some(k) => k,
        None => return Err(refuse(StatusCode::NOT_FOUND, json!({ "error": "unknown key" }))),
    };

    let state_of = model::state_of(&key);
    if state_of != model::State::Active {
        let name = state_of.as_str();
        return Err(refuse(
            StatusCode::FORBIDDEN,
            json!({ "error": format!("license {name}"), name: true }),
        ));
    }
    // Membership, not identity: a licence may cover several machines, and an
    // admin unbinding one is what takes it away again.
    if !claims.device_id.is_empty() && !model::bound_devices(&state.db, &key).contains(&claims.device_id) {
        return Err(refuse(StatusCode::CONFLICT, json!({ "error": "device mismatch" })));
    }

    Ok(Licence { key, device_id: claims.device_id })
}

/// Gate two: how much one licence may ask for in a day, and how many places it
/// is being asked from.
///
/// The ceiling refuses; the spread only reports. Auto-blocking a licence seen
/// from many addresses punishes people on mobile data, VPNs and hotspots, and a
/// wrongly blocked paying customer costs far more than the sharing it would
/// stop — so an admin decides that, from the event log.
pub struct DailyUsage {
    inner: Mutex<HashMap<String, KeyDay>>,
    pub cap: i64,
    alert_at: usize,
}

struct KeyDay {
    day: String,
    count: i64,
    ips: HashMap<String, Instant>,
    alerted: bool,
}

pub enum Verdict {
    Ok,
    /// Allowed, but worth an admin's eye: this many addresses within the hour.
    Spread(usize),
    TooMany,
}

impl DailyUsage {
    pub fn new(cap: i64, alert_at: usize) -> Self {
        Self { inner: Mutex::new(HashMap::new()), cap: cap.max(1), alert_at: alert_at.max(2) }
    }

    pub fn check(&self, key: &str, ip: &str) -> Verdict {
        let today = model::today();
        let mut all = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let entry = all.entry(key.to_string()).or_insert_with(|| KeyDay {
            day: today.clone(),
            count: 0,
            ips: HashMap::new(),
            alerted: false,
        });
        if entry.day != today {
            *entry = KeyDay { day: today, count: 0, ips: HashMap::new(), alerted: false };
        }

        entry.count += 1;
        if entry.count > self.cap {
            return Verdict::TooMany;
        }

        if !ip.is_empty() && ip != "unknown" {
            entry.ips.insert(ip.to_string(), Instant::now());
        }
        entry.ips.retain(|_, seen| seen.elapsed() < Duration::from_secs(3600));

        let distinct = entry.ips.len();
        if distinct >= self.alert_at && !entry.alerted {
            entry.alerted = true;
            return Verdict::Spread(distinct);
        }
        Verdict::Ok
    }
}

pub fn enforce_daily_cap(state: &AppState, licence: &Licence, ip: &str) -> Result<(), Refusal> {
    match state.usage.check(&licence.key.key, ip) {
        Verdict::Ok => Ok(()),
        Verdict::Spread(distinct) => {
            model::log_event(
                &state.db,
                "usage-anomaly",
                Some(&licence.key.key),
                ip,
                &format!("{distinct} addresses within the hour - for review, not blocked"),
            );
            Ok(())
        }
        Verdict::TooMany => {
            model::log_event(&state.db, "usage-cap", Some(&licence.key.key), ip, "daily limit");
            // It clears itself at midnight; nothing here ever marks a licence
            // blocked.
            Err(refuse(
                StatusCode::TOO_MANY_REQUESTS,
                json!({ "error": "daily download limit reached, try again tomorrow" }),
            ))
        }
    }
}

/// Gate three: the free trial, counted on the machine so that swapping the
/// email cannot hand anyone a fresh one.
pub fn enforce_trial(state: &AppState, licence: &Licence, ip: &str, cap: i64) -> Result<Option<i64>, Refusal> {
    let remaining = model::trial_remaining(&state.db, &licence.key, cap);
    match remaining {
        Some(0) => {
            model::log_event(&state.db, "trial-exhausted", Some(&licence.key.key), ip, &licence.device_id);
            Err(refuse(
                StatusCode::FORBIDDEN,
                json!({
                    "error": format!("Free trial finished ({cap} downloads). Please purchase a key."),
                    "trialExpired": true,
                }),
            ))
        }
        other => Ok(other),
    }
}

/// One download has happened: spend a trial credit if this is a trial, and
/// count it against the day either way.
pub fn spend_download(state: &AppState, licence: &Licence) {
    if licence.key.trial {
        let device = if licence.device_id.is_empty() {
            licence.key.device_id.clone().unwrap_or_default()
        } else {
            licence.device_id.clone()
        };
        if !device.is_empty() {
            model::spend_trial_download(&state.db, &device);
        }
    }
    model::bump_usage(&state.db, &licence.key.key);
}
