//! Per-address rate limits.
//!
//! The Node server uses express-rate-limit for four things: sign-in attempts on
//! the admin panel, sign-ups, activations and heartbeats. Those limits are the
//! only thing standing between the panel password and an unlimited number of
//! guesses, so the port keeps them rather than leaving them for later.
//!
//! A fixed window per address, counted in memory. Nothing is persisted: a
//! restart forgiving everyone is the right trade for a limiter that costs no
//! disk and cannot itself fail.
//!
//! Every refusal answers JSON. express-rate-limit's default is plain text, and
//! every client here parses JSON — a rate-limited reply used to blow up in
//! JSON.parse and the customer saw the word "parse" instead of being told to
//! wait.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

pub struct Limiter {
    window: Duration,
    inner: Mutex<HashMap<String, Window>>,
}

struct Window {
    started: Instant,
    hits: i64,
}

impl Limiter {
    pub fn new(window: Duration) -> Self {
        Self { window, inner: Mutex::new(HashMap::new()) }
    }

    /// Counts this request. `Err(minutes)` means it is over the limit and how
    /// long to wait. A `max` of 0 or less turns the limit off, which is what the
    /// admin panel's "no limit" setting means: mobile carriers put hundreds of
    /// real customers behind one address, so an operator has to be able to say
    /// that a cap is doing more harm than good.
    pub fn check(&self, who: &str, max: i64) -> Result<(), i64> {
        if max <= 0 {
            return Ok(());
        }
        let mut all = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        // Windows that have run out are dropped here rather than on a timer, so
        // an idle server holds nothing and there is no task to fail.
        all.retain(|_, w| w.started.elapsed() < self.window);

        let window = all.entry(who.to_string()).or_insert_with(|| Window { started: Instant::now(), hits: 0 });
        window.hits += 1;
        if window.hits > max {
            let left = self.window.saturating_sub(window.started.elapsed());
            return Err((left.as_secs() as i64 / 60).max(1));
        }
        Ok(())
    }
}

/// The four limits, built once and read per request so a cap changed in the
/// admin panel applies without a restart.
pub struct Limits {
    pub login: Limiter,
    pub signup: Limiter,
    pub activate: Limiter,
    pub heartbeat: Limiter,
    /// Sign-in attempts per address per 15 minutes.
    pub login_max: i64,
    pub activate_max: i64,
    pub heartbeat_max: i64,
}

impl Limits {
    pub fn from_env() -> Self {
        let num = |key: &str, fallback: i64| -> i64 {
            std::env::var(key).ok().and_then(|v| v.parse().ok()).filter(|n| *n >= 1).unwrap_or(fallback)
        };
        Self {
            login: Limiter::new(Duration::from_secs(15 * 60)),
            signup: Limiter::new(Duration::from_secs(3600)),
            activate: Limiter::new(Duration::from_secs(60)),
            heartbeat: Limiter::new(Duration::from_secs(60)),
            login_max: num("VELOX_LOGIN_PER_15MIN", 10),
            activate_max: num("VELOX_ACTIVATE_PER_MIN", 10),
            heartbeat_max: num("VELOX_HEARTBEAT_PER_MIN", 30),
        }
    }
}
