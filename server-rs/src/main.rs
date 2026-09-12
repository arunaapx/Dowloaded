//! Velox Downloader licence server, in Rust.
//!
//! This is the port of `server/` (Node + Express + a JSON file). It is being
//! built alongside it, not in place of it: both run, the same suites are
//! pointed at each in turn, and nothing is cut over until they agree.
//!
//!   cd server && npm test                                   # the Node one
//!   VELOX_TEST_BASE=http://127.0.0.1:4011 npm test           # this one
//!
//! The rules those suites encode — who may activate, how many machines a
//! licence covers, what a trial spends, which notice reaches whom — are the
//! specification. This file is finished when they pass against it.
//!
//! Phase 1 is what is here now: configuration, the admin panel's static files,
//! health, and the shape every later phase hangs off. The licence, extraction
//! and admin routes arrive next, each with its suite already written.

use axum::{http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use serde_json::json;
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tower_http::services::ServeDir;

// ------------------------------------------------------------------ config

/// Everything the process needs, read once at start-up.
///
/// The names match the Node server's, so one `.env` serves both while they run
/// side by side — a port that needed its own configuration would be a port
/// nobody could safely cut over.
// Fields land as their phase does; the struct is written once so the shape of
// the service is visible from the start rather than growing by accident.
#[allow(dead_code)]
struct Config {
    port: u16,
    data_dir: PathBuf,
    admin_user: String,
    admin_pass: String,
    /// Where the admin panel's HTML, CSS and JS live. Unchanged from the Node
    /// server: the panel is browser code and has no idea what serves it.
    public_dir: PathBuf,
    trial_downloads: u32,
    default_license_days: u32,
    default_device_limit: u32,
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
        }
    }
}

// ------------------------------------------------------------------- state

struct AppState {
    config: Config,
    started: Instant,
}

type Shared = Arc<AppState>;

// ------------------------------------------------------------------ routes

/// The same shape the Node server answers with, because the release script and
/// the deploy checks both read it.
async fn healthz(axum::extract::State(state): axum::extract::State<Shared>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "uptime": state.started.elapsed().as_secs_f64(),
    }))
}

/// Until the real routes land, anything else says so plainly rather than
/// pretending to be a licence server and answering wrongly.
async fn not_built_yet() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "ok": false,
            "error": "this route has not been ported yet",
        })),
    )
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn router(state: Shared) -> Router {
    let public = state.config.public_dir.clone();

    Router::new()
        .route("/healthz", get(healthz))
        // The admin panel is served exactly as the Node server serves it. It is
        // not ported and does not need to be: it talks to /admin/api/*, which
        // is, and it cannot tell the difference.
        .nest_service("/admin", ServeDir::new(public.clone()))
        .route("/login", get(|| async { "login page is served by the Node server for now" }))
        .fallback(not_built_yet)
        .with_state(state)
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()))
        .init();

    let config = Config::load();
    let port = config.port;

    if config.admin_pass.is_empty() {
        tracing::warn!("ADMIN_PASS is not set - the admin panel will refuse every login");
    }
    tracing::info!(
        data_dir = %config.data_dir.display(),
        public_dir = %config.public_dir.display(),
        trial_downloads = config.trial_downloads,
        default_license_days = config.default_license_days,
        default_device_limit = config.default_device_limit,
        "configuration loaded"
    );

    let state: Shared = Arc::new(AppState { config, started: Instant::now() });
    let app = router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("cannot bind");
    tracing::info!("velox-license (rust) listening on http://{addr} at {}", now_ms());
    axum::serve(listener, app).await.expect("server stopped");
}
