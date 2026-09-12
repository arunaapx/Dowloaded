//! The whole service as one router.
//!
//! It lives here rather than in `main` so the tests can drive it directly: every
//! suite that checks an admin route builds this with an in-memory ledger and
//! sends real requests through it, which is the only way to test the parts that
//! are about HTTP — the session cookie, the 401s, the path parameters.

use crate::{admin, routes::Shared};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::path::{Path, PathBuf};
use tower::Layer;
use tower_http::services::ServeDir;

/// The same shape the Node server answers with: the release script and the
/// deploy checks both read it.
async fn healthz(State(state): State<Shared>) -> impl IntoResponse {
    Json(json!({ "ok": true, "uptime": state.started.elapsed().as_secs_f64() }))
}

/// Anything not ported yet says so plainly rather than answering wrongly.
async fn not_built_yet() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "ok": false, "error": "this route has not been ported yet" })),
    )
}

/// The panel's own files are behind the session too, not only its API: the HTML
/// lists everything the panel can do and the JS is a map of every endpoint.
/// Someone who is not signed in is sent to the sign-in page.
async fn gate_admin_files(State(state): State<Shared>, request: Request, next: Next) -> Response {
    if admin::signed_in(&state, request.headers()) {
        return next.run(request).await;
    }
    Redirect::to("/login").into_response()
}

/// One file, or a 404 — for the two things a visitor who is not signed in yet
/// still has to be able to fetch.
async fn serve_file(path: PathBuf, content_type: &'static str) -> Response {
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, content_type)], Body::from(bytes)).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn file_route(path: PathBuf, content_type: &'static str) -> axum::routing::MethodRouter<Shared> {
    get(move || {
        let path = path.clone();
        async move { serve_file(path, content_type).await }
    })
}

pub fn app(state: Shared, public_dir: &Path) -> Router {
    // The panel: the Node server's own files, unported, behind the cookie.
    //
    // The gate wraps the file service itself rather than a Router holding it: a
    // nested router's fallback is ignored by the outer one, which quietly left
    // /admin/ answering the 501 that means "not ported yet".
    let panel = middleware::from_fn_with_state(state.clone(), gate_admin_files)
        .layer(ServeDir::new(public_dir).append_index_html_on_directories(true));

    Router::new()
        .route("/healthz", get(healthz))
        .merge(crate::routes::router())
        .merge(admin::router())
        // The sign-in page, and the stylesheet it is drawn with. A stylesheet
        // gives nothing away, and the page has to be reachable by someone who
        // has no session yet — that is what it is for.
        .route("/login", file_route(public_dir.join("login.html"), "text/html; charset=utf-8"))
        .route("/admin/admin.css", file_route(public_dir.join("admin.css"), "text/css; charset=utf-8"))
        .nest_service("/admin", panel)
        .route("/", get(root))
        .fallback(not_built_yet)
        .with_state(state)
}

async fn root(State(state): State<Shared>, request: Request) -> Redirect {
    if admin::signed_in(&state, request.headers()) {
        Redirect::to("/admin/")
    } else {
        Redirect::to("/login")
    }
}
