//! Velox Downloader store API.
//!
//! Three jobs, nothing more:
//!   1. count app downloads (the small number on the site),
//!   2. run a PayPal checkout,
//!   3. turn a completed payment into a licence key by asking the existing
//!      Node licence server for one.
//!
//! It deliberately owns no licence logic of its own - `server/` stays the single
//! source of truth for keys, so the admin panel keeps working unchanged.
//!
//! Routes avoid path parameters on purpose: ids travel in the JSON body, which
//! keeps the router identical across axum 0.7 and 0.8.

mod content;
mod paypal;

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use content::Sessions;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

// ---------------------------------------------------------------- config

struct Config {
    port: u16,
    paypal_base: String,
    paypal_client_id: String,
    paypal_secret: String,
    price: String,
    currency: String,
    product: String,
    licence_base: String,
    internal_token: String,
    licence_days: u32,
    live: bool,
    admin_pass: String,
    data_dir: String,
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

impl Config {
    fn from_env() -> Self {
        let live = env_or("PAYPAL_MODE", "sandbox").eq_ignore_ascii_case("live");
        Config {
            port: env_or("STORE_PORT", "8090").parse().unwrap_or(8090),
            paypal_base: if live {
                "https://api-m.paypal.com".into()
            } else {
                "https://api-m.sandbox.paypal.com".into()
            },
            paypal_client_id: env_or("PAYPAL_CLIENT_ID", ""),
            paypal_secret: env_or("PAYPAL_SECRET", ""),
            price: env_or("VELOX_PRICE", "19.99"),
            currency: env_or("VELOX_CURRENCY", "USD"),
            product: env_or("VELOX_PRODUCT", "Velox Downloader Pro - 1 year licence"),
            licence_base: env_or("LICENCE_SERVER_URL", "http://127.0.0.1:4000"),
            internal_token: env_or("VELOX_INTERNAL_TOKEN", ""),
            // Pro is sold per year, so keys expire after 365 days. Set to 0 for
            // lifetime keys if you ever switch the offer back.
            licence_days: env_or("VELOX_LICENCE_DAYS", "365").parse().unwrap_or(365),
            live,
            admin_pass: env_or("STORE_ADMIN_PASS", ""),
            data_dir: env_or("STORE_DATA_DIR", "data"),
        }
    }
}

// ---------------------------------------------------------------- storage

#[derive(Serialize, Deserialize, Default)]
struct Db {
    downloads: u64,
    #[serde(default)]
    orders: HashMap<String, Order>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Order {
    email: String,
    status: String,
    key: Option<String>,
    amount: Option<String>,
    created_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn data_file() -> PathBuf {
    PathBuf::from(env_or("STORE_DATA_DIR", "data")).join("store.json")
}

fn load_db() -> Db {
    std::fs::read_to_string(data_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write via a temp file + rename so a crash mid-write can't truncate the
/// counter, matching how the Node licence server persists its own database.
fn save_db(db: &Db) {
    let path = data_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if serde_json::to_string_pretty(db)
        .ok()
        .and_then(|s| std::fs::write(&tmp, s).ok())
        .is_some()
    {
        let _ = std::fs::rename(&tmp, &path);
    }
}

#[derive(Clone)]
struct AppState {
    cfg: Arc<Config>,
    db: Arc<Mutex<Db>>,
    site: Arc<Mutex<Value>>,
    sessions: Arc<Mutex<Sessions>>,
    http: reqwest::Client,
}

// ---------------------------------------------------------------- helpers

type Reply = (StatusCode, Json<serde_json::Value>);

fn ok(v: serde_json::Value) -> Reply {
    (StatusCode::OK, Json(v))
}

fn err(code: StatusCode, message: &str) -> Reply {
    (code, Json(json!({ "ok": false, "error": message })))
}

fn email_ok(v: &str) -> bool {
    let v = v.trim();
    v.len() <= 200
        && v.len() >= 5
        && v.matches('@').count() == 1
        && !v.starts_with('@')
        && !v.ends_with('@')
        && v.split('@').nth(1).map(|d| d.contains('.') && !d.ends_with('.')).unwrap_or(false)
        && !v.contains(char::is_whitespace)
}

// ---------------------------------------------------------------- routes

async fn stats(State(st): State<AppState>) -> Reply {
    let downloads = st.db.lock().await.downloads;
    let site = st.site.lock().await.clone();
    ok(json!({
        "ok": true,
        "downloads": downloads,
        "price": content::price_from(&site, &st.cfg.price),
        "currency": content::currency_from(&site, &st.cfg.currency),
        "product": content::product_from(&site, &st.cfg.product),
        "paypalClientId": st.cfg.paypal_client_id,
        "mode": if st.cfg.live { "live" } else { "sandbox" },
        "checkoutReady": !st.cfg.paypal_client_id.is_empty() && !st.cfg.paypal_secret.is_empty(),
    }))
}

/// The public site's copy. Anonymous - this is what every visitor renders from.
async fn get_content(State(st): State<AppState>) -> Reply {
    let site = st.site.lock().await.clone();
    ok(json!({ "ok": true, "content": site }))
}

#[derive(Deserialize)]
struct AdminLogin {
    password: String,
}

async fn admin_login(State(st): State<AppState>, Json(body): Json<AdminLogin>) -> Reply {
    if st.cfg.admin_pass.is_empty() {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "Admin is locked: STORE_ADMIN_PASS is not set on the server.",
        );
    }
    if !content::secret_eq(&body.password, &st.cfg.admin_pass) {
        return err(StatusCode::UNAUTHORIZED, "Wrong password.");
    }
    let token = st.sessions.lock().await.issue();
    ok(json!({ "ok": true, "token": token }))
}

#[derive(Deserialize)]
struct AdminSave {
    token: String,
    content: Value,
}

async fn admin_save_content(State(st): State<AppState>, Json(body): Json<AdminSave>) -> Reply {
    if !st.sessions.lock().await.valid(&body.token) {
        return err(StatusCode::UNAUTHORIZED, "Your admin session expired - sign in again.");
    }
    if !body.content.is_object() {
        return err(StatusCode::BAD_REQUEST, "Content must be a JSON object.");
    }
    if let Err(e) = content::save_content(&st.cfg.data_dir, &body.content) {
        eprintln!("[store] could not save content: {e}");
        return err(StatusCode::INTERNAL_SERVER_ERROR, "Could not save. Check the server's disk permissions.");
    }
    *st.site.lock().await = body.content.clone();
    println!("[store] site content updated");
    ok(json!({ "ok": true, "content": body.content }))
}

#[derive(Deserialize)]
struct AdminToken {
    token: String,
}

async fn admin_check(State(st): State<AppState>, Json(body): Json<AdminToken>) -> Reply {
    let valid = st.sessions.lock().await.valid(&body.token);
    ok(json!({ "ok": true, "valid": valid }))
}

async fn admin_logout(State(st): State<AppState>, Json(body): Json<AdminToken>) -> Reply {
    st.sessions.lock().await.revoke(&body.token);
    ok(json!({ "ok": true }))
}

/// Orders list for the admin screen, newest first - so the owner can see sales
/// and spot any "paid but key failed" case that needs fixing by hand.
async fn admin_orders(State(st): State<AppState>, Json(body): Json<AdminToken>) -> Reply {
    if !st.sessions.lock().await.valid(&body.token) {
        return err(StatusCode::UNAUTHORIZED, "Your admin session expired - sign in again.");
    }
    let db = st.db.lock().await;
    let mut rows: Vec<Value> = db
        .orders
        .iter()
        .map(|(id, o)| {
            json!({
                "id": id,
                "email": o.email,
                "status": o.status,
                "key": o.key,
                "amount": o.amount,
                "createdAt": o.created_at,
            })
        })
        .collect();
    rows.sort_by(|a, b| {
        b["createdAt"].as_u64().unwrap_or(0).cmp(&a["createdAt"].as_u64().unwrap_or(0))
    });
    ok(json!({ "ok": true, "orders": rows, "downloads": db.downloads }))
}

/// Bumped when someone clicks Download. A vanity counter, so it is deliberately
/// cheap and unauthenticated - it is never used for billing or licensing.
async fn count_download(State(st): State<AppState>) -> Reply {
    let mut db = st.db.lock().await;
    db.downloads += 1;
    let total = db.downloads;
    save_db(&db);
    ok(json!({ "ok": true, "downloads": total }))
}

#[derive(Deserialize)]
struct CreateOrder {
    email: String,
}

async fn create_order(State(st): State<AppState>, Json(body): Json<CreateOrder>) -> Reply {
    if !email_ok(&body.email) {
        return err(StatusCode::BAD_REQUEST, "Enter a valid email address - your key is sent there.");
    }
    if st.cfg.paypal_client_id.is_empty() || st.cfg.paypal_secret.is_empty() {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "Checkout is not configured yet. Set PAYPAL_CLIENT_ID and PAYPAL_SECRET.",
        );
    }

    let pp = paypal::PayPal {
        base: st.cfg.paypal_base.clone(),
        client_id: st.cfg.paypal_client_id.clone(),
        secret: st.cfg.paypal_secret.clone(),
        http: st.http.clone(),
    };

    // Price comes from the edited content so it can be changed at /Admin, but
    // content.rs re-validates it before it ever reaches PayPal.
    let (price, currency, product) = {
        let site = st.site.lock().await;
        (
            content::price_from(&site, &st.cfg.price),
            content::currency_from(&site, &st.cfg.currency),
            content::product_from(&site, &st.cfg.product),
        )
    };

    match pp.create_order(&price, &currency, &product).await {
        Ok(id) => {
            let mut db = st.db.lock().await;
            db.orders.insert(
                id.clone(),
                Order {
                    email: body.email.trim().to_lowercase(),
                    status: "created".into(),
                    key: None,
                    amount: None,
                    created_at: now_ms(),
                },
            );
            save_db(&db);
            ok(json!({ "ok": true, "id": id }))
        }
        Err(e) => {
            eprintln!("[store] create_order failed: {e}");
            err(StatusCode::BAD_GATEWAY, "Could not start the payment. Please try again.")
        }
    }
}

#[derive(Deserialize)]
struct CaptureOrder {
    #[serde(rename = "orderId")]
    order_id: String,
}

async fn capture_order(State(st): State<AppState>, Json(body): Json<CaptureOrder>) -> Reply {
    let order_id = body.order_id.trim().to_string();
    if order_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "missing orderId");
    }

    // The order must be one we created, so a stranger cannot capture an
    // arbitrary id and be handed a key.
    let existing = { st.db.lock().await.orders.get(&order_id).cloned() };
    let Some(order) = existing else {
        return err(StatusCode::NOT_FOUND, "unknown order");
    };

    // Already paid and issued - hand back the same key rather than making a
    // second one, so a page refresh mid-checkout cannot mint duplicates.
    if let Some(key) = order.key.clone() {
        return ok(json!({ "ok": true, "key": key, "email": order.email, "reused": true }));
    }

    let pp = paypal::PayPal {
        base: st.cfg.paypal_base.clone(),
        client_id: st.cfg.paypal_client_id.clone(),
        secret: st.cfg.paypal_secret.clone(),
        http: st.http.clone(),
    };

    let (status, amount) = match pp.capture_order(&order_id).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[store] capture failed for {order_id}: {e}");
            return err(StatusCode::BAD_GATEWAY, "Payment could not be confirmed. You have not been charged twice - contact support with your PayPal receipt.");
        }
    };

    if status != "COMPLETED" {
        let mut db = st.db.lock().await;
        if let Some(o) = db.orders.get_mut(&order_id) {
            o.status = status.clone();
        }
        save_db(&db);
        return err(StatusCode::PAYMENT_REQUIRED, "Payment was not completed.");
    }

    // Paid. Now ask the licence server for a key.
    match issue_licence(&st, &order.email).await {
        Ok(key) => {
            let mut db = st.db.lock().await;
            if let Some(o) = db.orders.get_mut(&order_id) {
                o.status = "completed".into();
                o.key = Some(key.clone());
                o.amount = Some(amount.clone());
            }
            save_db(&db);
            println!("[store] issued {key} to {} for {amount}", order.email);
            ok(json!({ "ok": true, "key": key, "email": order.email }))
        }
        Err(e) => {
            // Money taken but no key: record it loudly so it can be fixed by
            // hand in the admin panel rather than silently lost.
            eprintln!("[store] PAID BUT KEY FAILED order={order_id} email={} : {e}", order.email);
            let mut db = st.db.lock().await;
            if let Some(o) = db.orders.get_mut(&order_id) {
                o.status = "paid-key-failed".into();
                o.amount = Some(amount);
            }
            save_db(&db);
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Your payment went through but the key could not be created. Email us your PayPal receipt and we will send it straight away.",
            )
        }
    }
}

/// Ask the Node licence server to mint a key. Uses the internal endpoint on
/// localhost with a shared token, so this service never needs admin rights.
async fn issue_licence(st: &AppState, email: &str) -> Result<String, String> {
    let res = st
        .http
        .post(format!("{}/internal/issue-key", st.cfg.licence_base))
        .header("x-internal-token", &st.cfg.internal_token)
        .json(&json!({
            "email": email,
            "days": st.cfg.licence_days,
            "note": "paypal-purchase",
        }))
        .send()
        .await
        .map_err(|e| format!("licence server unreachable: {e}"))?;

    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("licence server returned {status}: {text}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "licence server sent invalid JSON".to_string())?;
    v.get("key")
        .and_then(|k| k.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "licence server response had no key".to_string())
}

async fn healthz() -> Reply {
    ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------- main

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    let cfg = Config::from_env();

    if cfg.paypal_client_id.is_empty() || cfg.paypal_secret.is_empty() {
        eprintln!("[store] WARNING: PAYPAL_CLIENT_ID / PAYPAL_SECRET are unset - checkout is disabled until you set them.");
    }
    if cfg.internal_token.is_empty() {
        eprintln!("[store] WARNING: VELOX_INTERNAL_TOKEN is unset - the licence server will refuse to issue keys.");
    }
    if cfg.live {
        println!("[store] PayPal mode: LIVE - real money.");
    } else {
        println!("[store] PayPal mode: sandbox (test money).");
    }

    if cfg.admin_pass.is_empty() {
        eprintln!("[store] WARNING: STORE_ADMIN_PASS is unset - /Admin cannot be signed into.");
    }

    let port = cfg.port;
    let site = content::load_content(&cfg.data_dir);
    let state = AppState {
        cfg: Arc::new(cfg),
        db: Arc::new(Mutex::new(load_db())),
        site: Arc::new(Mutex::new(site)),
        sessions: Arc::new(Mutex::new(Sessions::default())),
        http: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("http client"),
    };

    // In production nginx serves the site from the same origin, so CORS is not
    // needed there; this keeps `npm run dev` on :5173 working.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/store/stats", get(stats))
        .route("/api/store/downloads", post(count_download))
        .route("/api/store/orders", post(create_order))
        .route("/api/store/orders/capture", post(capture_order))
        .route("/api/store/content", get(get_content))
        .route("/api/store/admin/login", post(admin_login))
        .route("/api/store/admin/check", post(admin_check))
        .route("/api/store/admin/logout", post(admin_logout))
        .route("/api/store/admin/content", post(admin_save_content))
        .route("/api/store/admin/orders", post(admin_orders))
        .route("/healthz", get(healthz))
        .layer(cors)
        .with_state(state);

    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("[store] cannot bind {addr}: {e}"));
    println!("[store] listening on http://{addr}");
    axum::serve(listener, app).await.expect("server error");
}
