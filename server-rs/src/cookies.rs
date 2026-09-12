//! The YouTube cookie jar the extractor uses and the admin panel manages.
//!
//! YouTube refuses an increasing share of videos to anonymous requests with
//! "Sign in to confirm you're not a bot". That gate is not about the address —
//! from a clean residential line the watch page returns 200 while the player API
//! still refuses — and no player client, JS runtime or proxy gets past it. The
//! only thing that works is sending cookies from a signed-in session.
//!
//! ── TREAT THE STORED FILE AS A PASSWORD ───────────────────────────────────
//! A cookies.txt for youtube.com carries live Google session tokens. Anyone
//! holding it is signed in as that account until the cookies expire or the
//! account signs out everywhere. So:
//!   * it is stored under DATA_DIR, which is gitignored, 0600 where the
//!     platform honours it;
//!   * it is never sent back to the browser, not even to the admin who uploaded
//!     it — `status` returns counts and dates, never a value;
//!   * nothing here writes a cookie name's value to a log.
//!
//! Use an account you are willing to lose. YouTube's terms do not allow this,
//! and accounts used this way do get banned.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Cookies that actually carry a Google session. Without one of these the file
/// authenticates nothing however many lines it has — which is the most common
/// upload mistake: exporting from a signed-out tab, or exporting only the
/// current page's cookies.
const SESSION_COOKIES: [&str; 10] = [
    "SID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID",
    "__Secure-1PSID",
    "__Secure-3PSID",
    "__Secure-1PAPISID",
    "__Secure-3PAPISID",
    "LOGIN_INFO",
];

pub struct Jar {
    file: PathBuf,
}

struct Cookie {
    domain: String,
    expiry: i64,
    name: String,
}

struct Parsed {
    cookies: Vec<Cookie>,
}

impl Jar {
    pub fn new(data_dir: &Path) -> Self {
        Self { file: data_dir.join("yt-cookies.txt") }
    }

    pub fn path(&self) -> &Path {
        &self.file
    }

    pub fn present(&self) -> bool {
        self.file.exists()
    }

    /// Where the extractor should look, or nowhere if there is no jar.
    pub fn active_path(&self) -> Option<PathBuf> {
        self.present().then(|| self.file.clone())
    }

    /// Validate and store an uploaded jar. Nothing is written unless the file is
    /// usable, so a bad upload cannot replace a working credential.
    pub fn save(&self, text: &str) -> Result<Value, (String, Vec<String>)> {
        let parsed = parse(text);
        let faults = faults(&parsed);
        if let Some(first) = faults.first().cloned() {
            // What is wrong with the contents, in the order it matters. The
            // parser also notes malformed lines, deliberately left out: "export
            // in Netscape format" is what the operator has to do about it, and a
            // line-by-line list on top of that only buries the instruction.
            return Err((first, faults));
        }

        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Through a temp file: a half-written jar would authenticate as nobody
        // and fail every extraction until someone noticed.
        let tmp = self.file.with_extension("txt.tmp");
        std::fs::write(&tmp, text).map_err(|e| (format!("could not store the file: {e}"), Vec::new()))?;
        restrict(&tmp);
        std::fs::rename(&tmp, &self.file).map_err(|e| (format!("could not store the file: {e}"), Vec::new()))?;
        restrict(&self.file);
        Ok(summarise(&parsed))
    }

    pub fn clear(&self) {
        let _ = std::fs::remove_file(&self.file);
    }

    /// Metadata only. There is no path by which the file's contents leave here.
    pub fn status(&self) -> Value {
        if !self.present() {
            return json!({ "present": false, "active": false });
        }
        let text = match std::fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(e) => return json!({ "present": true, "active": false, "error": format!("unreadable: {e}") }),
        };
        let parsed = parse(&text);
        let mut out = summarise(&parsed);
        if let Some(map) = out.as_object_mut() {
            map.insert("present".into(), json!(true));
            map.insert("active".into(), json!(true));
            map.insert("bytes".into(), json!(text.len()));
            map.insert("problems".into(), json!(faults(&parsed)));
            map.insert(
                "uploadedAt".into(),
                std::fs::metadata(&self.file)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| json!(iso_from_secs(d.as_secs() as i64)))
                    .unwrap_or(Value::Null),
            );
        }
        out
    }
}

/// Netscape cookies.txt: domain, includeSubdomains, path, secure, expiry, name,
/// value — tab separated. A leading `#HttpOnly_` is a browser-extension
/// convention and part of the domain field, not a comment.
fn parse(text: &str) -> Parsed {
    let mut cookies = Vec::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') && !line.starts_with("#HttpOnly_") {
            continue;
        }
        let body = raw.trim_end_matches(['\r', '\n']).strip_prefix("#HttpOnly_").unwrap_or(raw);
        let parts: Vec<&str> = body.split('\t').collect();
        if parts.len() < 7 {
            // Not a cookie line. Counted by its absence: a file made of these
            // has no cookies in it, which is what the operator is told.
            continue;
        }
        cookies.push(Cookie {
            domain: parts[0].trim_start_matches('.').to_lowercase(),
            // 0 means a session cookie: it dies with the browser and is useless
            // here.
            expiry: parts[4].trim().parse().unwrap_or(0),
            name: parts[5].trim().to_string(),
        });
    }

    Parsed { cookies }
}

fn is_google(domain: &str) -> bool {
    domain == "youtube.com"
        || domain == "google.com"
        || domain.ends_with(".youtube.com")
        || domain.ends_with(".google.com")
}

/// What is wrong with this file, in the order it matters. Empty means usable.
fn faults(parsed: &Parsed) -> Vec<String> {
    let mut out = Vec::new();
    if parsed.cookies.is_empty() {
        out.push("No cookies found. Export in Netscape format (cookies.txt), not JSON.".into());
        return out;
    }

    let google: Vec<&Cookie> = parsed.cookies.iter().filter(|c| is_google(&c.domain)).collect();
    if google.is_empty() {
        out.push("No youtube.com or google.com cookies. Export while on youtube.com.".into());
        return out;
    }

    let session: Vec<&&Cookie> = google.iter().filter(|c| SESSION_COOKIES.contains(&c.name.as_str())).collect();
    if session.is_empty() {
        out.push("No session cookies (SID/SAPISID/__Secure-1PSID). Sign in first, then export.".into());
    }

    let now = crate::model::now_ms() / 1000;
    if !session.is_empty() && !session.iter().any(|c| c.expiry > now) {
        out.push("Every session cookie has already expired. Export a fresh copy.".into());
    }
    out
}

fn summarise(parsed: &Parsed) -> Value {
    let now = crate::model::now_ms() / 1000;
    let google: Vec<&Cookie> = parsed.cookies.iter().filter(|c| is_google(&c.domain)).collect();
    let session: Vec<&&Cookie> = google.iter().filter(|c| SESSION_COOKIES.contains(&c.name.as_str())).collect();

    // The names only — never the values.
    let mut names: Vec<String> = session.iter().map(|c| c.name.clone()).collect();
    names.sort();
    let mut domains: Vec<String> = parsed.cookies.iter().map(|c| c.domain.clone()).collect();
    domains.sort();
    domains.dedup();
    domains.truncate(12);

    let soonest = session.iter().map(|c| c.expiry).filter(|e| *e > 0).min();

    json!({
        "total": parsed.cookies.len(),
        "google": google.len(),
        "session": session.len(),
        "sessionNames": names,
        "domains": domains,
        "expiresAt": soonest.map(iso_from_secs),
        "expiredCount": session.iter().filter(|c| c.expiry > 0 && c.expiry <= now).count(),
    })
}

/// An ISO timestamp without a date library: the panel only prints it.
fn iso_from_secs(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    let (y, m, d) = crate::model::civil_from_days_pub(days);
    let (h, min, s) = (rest / 3600, (rest % 3600) / 60, rest % 60);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}.000Z")
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {
    // Windows inherits the data directory's ACL; the server runs on Linux.
}
