//! Velox Downloader licence server, in Rust.
//!
//! This is the port of `server/` (Node + Express + a JSON file). It is built
//! alongside it, not in place of it: both run, the same suites are pointed at
//! each in turn, and nothing is cut over until they agree.
//!
//!   cd server && npm test                                   # the Node one
//!   VELOX_TEST_BASE=http://127.0.0.1:4011 npm test           # this one
//!
//! Here now: everything the Node server does. The three calls the desktop app
//! makes, the public pricing the website reads, the gated extraction routes, and
//! the admin API behind them — keys, devices, plans, notices, settings and the
//! YouTube cookie jar — serving the Node panel's own HTML unchanged. What is
//! left is proving the two agree (the same suites against each in turn) and then
//! the cutover.

use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Instant};
use velox_license::{
    app::app,
    auth::Tokens,
    cookies::Jar,
    db::Db,
    extract::Extractor,
    gate::DailyUsage,
    limit::Limits,
    routes::{AppState, Shared},
};

// ------------------------------------------------------------------ config

/// Everything the process needs, read once at start-up.
///
/// The names match the Node server's, so one `.env` serves both while they run
/// side by side — a port that needed its own configuration would be a port
/// nobody could safely cut over, or roll back.
struct Config {
    port: u16,
    data_dir: PathBuf,
    admin_user: String,
    admin_pass: String,
    /// The admin panel's HTML, CSS and JS, served straight from the Node
    /// server's folder: it is browser code that talks to /admin/api/*, and has
    /// no idea what serves it.
    public_dir: PathBuf,
    trial_downloads: i64,
    default_license_days: i64,
    default_device_limit: i64,
    token_ttl_hours: i64,
    /// Where the bundled extractor lives, if it is bundled. On the VPS it is
    /// installed on PATH instead and this is simply not found.
    bin_dir: Option<PathBuf>,
    /// What one licence may ask for in a day, and how many addresses within an
    /// hour is worth an admin's attention.
    daily_cap: i64,
    ip_alert: usize,
    /// Sign-ups per hour from one address, unless the panel says otherwise.
    signup_per_hour: i64,
    /// The secret the store service calls /internal/issue-key with. Empty
    /// switches that route off rather than leaving it open.
    internal_token: String,
}

fn env_string(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn env_number<T: std::str::FromStr>(key: &str, fallback: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(fallback)
}

impl Config {
    fn load() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        // ../server is where the Node service keeps its data and its panel.
        // Sharing both is what lets the two run against the same state while
        // the port is being checked.
        let node_server = root.parent().map(|p| p.join("server")).unwrap_or_else(|| root.clone());

        Self {
            port: env_number("PORT", 4011),
            data_dir: std::env::var("DATA_DIR").map(PathBuf::from).unwrap_or_else(|_| node_server.join("data")),
            admin_user: env_string("ADMIN_USER", "admin"),
            admin_pass: env_string("ADMIN_PASS", ""),
            public_dir: std::env::var("PUBLIC_DIR").map(PathBuf::from).unwrap_or_else(|_| node_server.join("public")),
            trial_downloads: env_number("VELOX_TRIAL_DOWNLOADS", 5),
            default_license_days: env_number("DEFAULT_LICENSE_DAYS", 30),
            default_device_limit: env_number("VELOX_DEVICE_LIMIT", 1),
            token_ttl_hours: env_number("TOKEN_TTL_HOURS", 24),
            bin_dir: std::env::var("VELOX_BIN_DIR").ok().map(PathBuf::from),
            daily_cap: env_number("VELOX_DAILY_CAP", 300),
            ip_alert: env_number("VELOX_IP_ALERT", 6),
            signup_per_hour: env_number("VELOX_SIGNUP_PER_HOUR", 60),
            internal_token: env_string("VELOX_INTERNAL_TOKEN", ""),
        }
    }
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()),
        )
        .init();

    let config = Config::load();
    if config.admin_pass.is_empty() {
        tracing::warn!("ADMIN_PASS is not set - the admin panel will refuse every login");
    }

    let db = Db::open(&config.data_dir.join("licenses.db")).expect("cannot open the licence database");
    match db.counts() {
        Ok(c) => tracing::info!(
            keys = c.keys, devices = c.devices, plans = c.plans, notices = c.notices,
            "ledger opened"
        ),
        Err(e) => tracing::warn!("ledger opened but could not be counted: {e}"),
    }

    if velox_license::model::seed_plans(&db) {
        tracing::info!("seeded the three pricing tiers, unpriced and unpublished");
    }

    let tokens = Tokens::from_data_dir(&config.data_dir, config.token_ttl_hours)
        .expect("cannot read or create the token secret");

    let public_dir = config.public_dir.clone();
    let jar = Jar::new(&config.data_dir);
    let extractor = Extractor::from_env(config.bin_dir.as_deref());
    // A jar uploaded before the last restart is used again without anyone having
    // to re-upload it: a restart must not quietly drop back to anonymous
    // extraction, because the failure looks like YouTube blocking the server.
    if let Some(path) = jar.active_path() {
        tracing::info!("using the stored YouTube cookie jar");
        extractor.set_cookies(Some(path));
    }
    if config.internal_token.is_empty() {
        tracing::warn!("VELOX_INTERNAL_TOKEN is not set - /internal/issue-key is switched off");
    }

    let state: Shared = Arc::new(AppState {
        db,
        tokens,
        extractor,
        usage: DailyUsage::new(config.daily_cap, config.ip_alert),
        jar,
        limits: Limits::from_env(),
        admin_user: config.admin_user.clone(),
        admin_pass: config.admin_pass.clone(),
        internal_token: config.internal_token.clone(),
        trial_downloads: config.trial_downloads,
        default_license_days: config.default_license_days,
        default_device_limit: config.default_device_limit,
        signup_per_hour: config.signup_per_hour,
        started: Instant::now(),
    });

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("cannot bind");
    tracing::info!("velox-license (rust) listening on http://{addr}");
    tracing::info!("admin user: {}", config.admin_user);
    // with_connect_info because /internal/issue-key checks the peer address
    // itself: a shared token alone would be one nginx mistake away from being
    // reachable from the internet.
    let service = app(state, &public_dir).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, service).await.expect("server stopped");
}
