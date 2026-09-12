//! Velox Downloader licence server, in Rust.
//!
//! This is the port of `server/` (Node + Express + a JSON file). It is built
//! alongside it, not in place of it: both run, the same suites are pointed at
//! each in turn, and nothing is cut over until they agree.
//!
//!   cd server && npm test                                   # the Node one
//!   VELOX_TEST_BASE=http://127.0.0.1:4011 npm test           # this one
//!
//! Here now: configuration, the ledger, the admin panel's static files, and the
//! three calls the desktop app makes — sign-up, activation and the heartbeat —
//! plus the public pricing the website reads. The gated extraction routes and
//! the admin API are the phases after this; anything not yet ported answers 501
//! saying exactly that, rather than pretending to be a licence server.

use axum::{http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use serde_json::json;
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Instant};
use tower_http::services::ServeDir;
use velox_license::{
    auth::Tokens,
    db::Db,
    routes::{self, AppState, Shared},
};

// ------------------------------------------------------------------ config

/// Everything the process needs, read once at start-up.
///
/// The names match the Node server's, so one `.env` serves both while they run
/// side by side — a port that needed its own configuration would be a port
/// nobody could safely cut over, or roll back.
#[allow(dead_code)]
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
        }
    }
}

// ------------------------------------------------------------------ routes

/// The same shape the Node server answers with: the release script and the
/// deploy checks both read it.
async fn healthz(axum::extract::State(state): axum::extract::State<Shared>) -> impl IntoResponse {
    Json(json!({ "ok": true, "uptime": state.started.elapsed().as_secs_f64() }))
}

/// Anything not ported yet says so plainly rather than answering wrongly.
async fn not_built_yet() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "ok": false, "error": "this route has not been ported yet" })),
    )
}

fn app(state: Shared, public_dir: PathBuf) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .merge(routes::router())
        // The admin panel is served exactly as the Node server serves it. It is
        // not ported and does not need to be.
        .nest_service("/admin", ServeDir::new(public_dir))
        .fallback(not_built_yet)
        .with_state(state)
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

    let tokens = Tokens::from_data_dir(&config.data_dir, config.token_ttl_hours)
        .expect("cannot read or create the token secret");

    let public_dir = config.public_dir.clone();
    let state: Shared = Arc::new(AppState {
        db,
        tokens,
        trial_downloads: config.trial_downloads,
        default_license_days: config.default_license_days,
        default_device_limit: config.default_device_limit,
        started: Instant::now(),
    });

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("cannot bind");
    tracing::info!("velox-license (rust) listening on http://{addr}");
    axum::serve(listener, app(state, public_dir)).await.expect("server stopped");
}
