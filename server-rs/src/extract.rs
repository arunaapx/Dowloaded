//! Server-side extraction: the part a cracked client cannot have.
//!
//! The thin client ships no extractor. It asks the server to read a link — the
//! metadata and the menu of options — and then to turn a chosen option into
//! direct CDN URLs, which the client fetches with its own bandwidth. No media
//! ever passes through the server; it only answers questions about links.
//!
//! There is no licence logic here. Who may ask is decided in `routes`, and the
//! rules it decides with live in `model`. This file knows only how to ask
//! yt-dlp something and how to read the answer.

use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

pub struct Extractor {
    binary: PathBuf,
    socket_timeout: u32,
    max_retries: u32,
    timeout: Duration,
    /// The cookie jar, if one has been uploaded. Behind a lock because an admin
    /// can replace it while the server runs, and an upload that only took effect
    /// after a restart would look like it had not worked.
    cookies: Mutex<Option<PathBuf>>,
    /// YouTube's default player client now refuses a growing share of ordinary
    /// videos while the android one still serves them, so both are asked for
    /// unless an operator says otherwise.
    player_clients: Option<String>,
    /// The supported-sites list is long and barely changes.
    sites_cache: Mutex<Option<(Instant, Vec<String>)>>,
}

impl Extractor {
    pub fn from_env(bin_dir: Option<&Path>) -> Self {
        let binary = resolve_binary(bin_dir);
        let cookies = ["VELOX_YTDLP_COOKIES", "VELOX_YTDLP_COOKIES_AUTO"]
            .iter()
            .filter_map(|k| std::env::var(k).ok())
            .map(PathBuf::from)
            .find(|p| p.exists());
        let clients = std::env::var("VELOX_YT_PLAYER_CLIENTS").unwrap_or_default();
        let player_clients = if clients.trim().eq_ignore_ascii_case("off") {
            None
        } else if clients.trim().is_empty() {
            Some("default,android".to_string())
        } else {
            Some(clients.trim().to_string())
        };

        Self {
            binary,
            socket_timeout: env_num("VELOX_SOCKET_TIMEOUT_SEC", 20),
            max_retries: env_num("VELOX_DL_RETRIES", 1),
            timeout: Duration::from_secs(env_num("VELOX_EXTRACT_TIMEOUT_SEC", 45) as u64),
            cookies: Mutex::new(cookies),
            player_clients,
            sites_cache: Mutex::new(None),
        }
    }

    /// Point at a newly uploaded jar, or at nothing when one is deleted. Takes
    /// effect on the next call.
    pub fn set_cookies(&self, path: Option<PathBuf>) {
        if let Ok(mut slot) = self.cookies.lock() {
            *slot = path;
        }
    }

    /// The flags every call shares: how long to wait, how hard to retry, whose
    /// cookies to send, and which YouTube client to ask as.
    fn common_args(&self) -> Vec<String> {
        let mut args = vec![
            "--socket-timeout".into(),
            self.socket_timeout.to_string(),
            "--retries".into(),
            self.max_retries.to_string(),
            "--fragment-retries".into(),
            self.max_retries.to_string(),
        ];
        if let Some(cookies) = self.cookies.lock().ok().and_then(|c| c.clone()) {
            args.push("--cookies".into());
            args.push(cookies.display().to_string());
        }
        if let Some(clients) = &self.player_clients {
            args.push("--extractor-args".into());
            args.push(format!("youtube:player_client={clients}"));
        }
        args
    }

    async fn run(&self, args: Vec<String>, limit: Duration) -> Result<String, String> {
        let mut child = Command::new(&self.binary)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("cannot start the extractor: {e}"))?;

        let mut stdout = child.stdout.take().ok_or("no stdout")?;
        let mut stderr = child.stderr.take().ok_or("no stderr")?;
        // Bytes, not a String: the engine prints titles, channel names and its
        // own list of sites in every script on earth, and on Windows it writes
        // them in the console code page. Reading straight into a String throws
        // the entire answer away the moment one byte is not UTF-8 — which looked
        // exactly like a site list with nothing in it.
        let mut out = Vec::new();
        let mut err = Vec::new();

        let work = async {
            let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
            a?;
            b?;
            child.wait().await
        };

        let (out, err) = match timeout(limit, work).await {
            // A link that takes longer than this is a link the customer is not
            // waiting for either.
            Err(_) => return Err("this link took too long to read".to_string()),
            Ok(Err(e)) => return Err(format!("the extractor stopped: {e}")),
            Ok(Ok(status)) => (
                status.success().then(|| String::from_utf8_lossy(&out).into_owned()),
                String::from_utf8_lossy(&err).into_owned(),
            ),
        };
        out.ok_or_else(|| clean_err(&err))
    }

    /// Read a link: what it is, and the menu of options to offer for it.
    pub async fn probe(&self, url: &str) -> Value {
        let url = match normalize_http_url(url) {
            Some(u) => u,
            None => return json!({ "ok": false, "error": "invalid or missing url" }),
        };

        let mut args = vec!["-J".into(), "--no-warnings".into(), "--no-playlist".into()];
        args.extend(self.common_args());
        args.push(url);

        let out = match self.run(args, self.timeout).await {
            Ok(out) => out,
            Err(e) => return json!({ "ok": false, "error": if e.is_empty() { "could not read this link".into() } else { e } }),
        };
        let info: Value = match serde_json::from_str(&out) {
            Ok(v) => v,
            Err(_) => return json!({ "ok": false, "error": "could not parse video info" }),
        };

        let mut heights: Vec<i64> = info["formats"]
            .as_array()
            .map(|fs| fs.iter().filter_map(|f| f["height"].as_i64()).collect())
            .unwrap_or_default();
        heights.sort_unstable();
        heights.dedup();
        let max_height = heights.last().copied().unwrap_or(0);
        // Always offer down to 360p and Best, whatever the source has.
        let ceiling = max_height.max(360);

        json!({
            "ok": true,
            "meta": {
                "title": info["title"].as_str().unwrap_or_default(),
                "uploader": info["uploader"].as_str().or(info["channel"].as_str()).unwrap_or_default(),
                "duration": info["duration"].as_f64().unwrap_or(0.0),
                "thumbnail": info["thumbnail"].as_str().unwrap_or_default(),
                "isPlaylist": info["_type"].as_str() == Some("playlist"),
                "extractor": info["extractor_key"].as_str().or(info["extractor"].as_str()).unwrap_or_default(),
                "maxHeight": max_height,
            },
            "videoOptions": quality_ladder(ceiling),
            "audioOptions": audio_formats(),
        })
    }

    /// Turn a chosen option into the URLs the client will fetch.
    pub async fn resolve(&self, url: &str, sel: &Selection) -> Value {
        let url = match normalize_http_url(url) {
            Some(u) => u,
            None => return json!({ "ok": false, "error": "invalid or missing url" }),
        };
        let audio = sel.mode.as_deref() == Some("audio");
        let selector = if audio {
            audio_selector()
        } else {
            video_selector(sel.quality.as_deref(), sel.vcodec.as_deref())
        };

        let mut args = vec![
            "-f".into(),
            selector,
            "-g".into(),
            "--no-warnings".into(),
            "--no-playlist".into(),
        ];
        args.extend(self.common_args());
        args.push(url.clone());

        let out = match self.run(args, self.timeout).await {
            Ok(out) => out,
            Err(e) => return json!({ "ok": false, "error": if e.is_empty() { "could not resolve this video".into() } else { e } }),
        };
        let streams: Vec<&str> = out
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("http://") || l.starts_with("https://"))
            .take(2)
            .collect();
        if streams.is_empty() {
            return json!({ "ok": false, "error": "no downloadable stream found" });
        }

        json!({
            "ok": true,
            "mode": if audio { "audio" } else { "video" },
            // Two streams means video and audio arrived separately, which is
            // every YouTube quality above 720p: the client merges them.
            "needsMerge": !audio && streams.len() >= 2,
            "streams": streams,
            "container": if audio { sel.aformat.clone().unwrap_or_else(|| "mp3".into()) } else { "mp4".into() },
            // Many CDNs want the page it came from.
            "headers": { "Referer": url },
        })
    }

    pub async fn search(&self, query: &str, limit: Option<i64>) -> Value {
        let q = query.trim();
        if q.is_empty() {
            return json!({ "ok": false, "error": "empty query" });
        }
        let n = limit.unwrap_or(10).clamp(1, 25);
        let mut args = vec!["-J".into(), "--flat-playlist".into(), "--no-warnings".into()];
        args.extend(self.common_args());
        args.push(format!("ytsearch{n}:{q}"));

        let out = match self.run(args, self.timeout).await {
            Ok(out) => out,
            Err(e) => return json!({ "ok": false, "error": if e.is_empty() { "search failed".into() } else { e } }),
        };
        let parsed: Value = match serde_json::from_str(&out) {
            Ok(v) => v,
            Err(_) => return json!({ "ok": false, "error": "could not parse search results" }),
        };

        let items: Vec<Value> = parsed["entries"]
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .map(|e| {
                        let id = e["id"].as_str().unwrap_or_default();
                        let url = match e["url"].as_str() {
                            Some(u) if u.starts_with("http") => u.to_string(),
                            _ => format!("https://www.youtube.com/watch?v={id}"),
                        };
                        let thumbnail = e["thumbnails"]
                            .as_array()
                            .and_then(|t| t.last())
                            .and_then(|t| t["url"].as_str())
                            .map(str::to_string)
                            .or_else(|| e["thumbnail"].as_str().map(str::to_string))
                            .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"));
                        json!({
                            "id": id,
                            "title": e["title"].as_str().unwrap_or_default(),
                            "url": url,
                            "channel": e["channel"].as_str().or(e["uploader"].as_str()).unwrap_or_default(),
                            "duration": e["duration"].as_f64().unwrap_or(0.0),
                            "thumbnail": thumbnail,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        json!({ "ok": true, "items": items })
    }

    /// The supported-sites list. Long, and it barely changes, so it is read at
    /// most once every six hours.
    pub async fn list_sites(&self) -> Value {
        if let Ok(cache) = self.sites_cache.lock() {
            if let Some((at, list)) = cache.as_ref() {
                if at.elapsed() < Duration::from_secs(6 * 3600) {
                    return json!({ "ok": true, "list": list });
                }
            }
        }

        let args = vec!["--color".into(), "never".into(), "--list-extractors".into()];
        let out = match self.run(args, Duration::from_secs(60)).await {
            Ok(out) => out,
            Err(e) => return json!({ "ok": false, "error": if e.is_empty() { "could not list sites".into() } else { e } }),
        };
        let list: Vec<String> = out.lines().map(|l| strip_ansi(l.trim())).filter(|l| !l.is_empty()).collect();
        if let Ok(mut cache) = self.sites_cache.lock() {
            *cache = Some((Instant::now(), list.clone()));
        }
        json!({ "ok": true, "list": list })
    }
}

#[derive(Default)]
pub struct Selection {
    pub mode: Option<String>,
    pub quality: Option<String>,
    pub vcodec: Option<String>,
    pub aformat: Option<String>,
}

// ----------------------------------------------------------------- helpers

fn env_num(key: &str, fallback: u32) -> u32 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(fallback)
}

/// The bundled binary if there is one, otherwise whatever is on PATH — which is
/// how it is installed on the VPS. The shipped name is tried first because the
/// desktop build renames it; the server usually has neither and falls through.
fn resolve_binary(bin_dir: Option<&Path>) -> PathBuf {
    let names: [&str; 2] = if cfg!(windows) {
        ["velox-core.exe", "yt-dlp.exe"]
    } else {
        ["velox-core", "yt-dlp"]
    };
    if let Some(dir) = bin_dir {
        for name in names {
            let candidate = dir.join(name);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from("yt-dlp")
}

/// Take the colour codes out of a line. `--color never` is asked for, but a
/// build that ignores it would otherwise put escape sequences in front of every
/// site name in the list the app shows.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // ESC [ … final-byte: skip to the end of the sequence.
        if chars.next() == Some('[') {
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

fn normalize_http_url(url: &str) -> Option<String> {
    let u = url.trim();
    if u.starts_with("http://") || u.starts_with("https://") {
        Some(u.to_string())
    } else {
        None
    }
}

/// What yt-dlp said went wrong, in one line. Its own output puts the extractor
/// and the cause first, so the head is what is worth keeping — and the engine's
/// name is taken out, because a customer should not have to learn it.
fn clean_err(stderr: &str) -> String {
    let line = stderr
        .lines()
        .rev()
        .find(|l| l.to_lowercase().contains("error"))
        .unwrap_or("")
        .trim();
    let line = if line.is_empty() { stderr.trim() } else { line };
    let cleaned = line.strip_prefix("ERROR:").unwrap_or(line).trim();
    let cleaned = cleaned.replace("yt-dlp", "the download engine").replace("yt_dlp", "the download engine");
    cleaned.chars().take(300).collect()
}

/// Ask for the quality the customer chose, and take video and audio separately
/// when that is what the site offers: on YouTube everything above 720p is
/// adaptive, so asking for a single file silently hands back 720p. h264 and aac
/// come first so the client's copy-merge into mp4 needs no re-encoding.
pub fn video_selector(quality: Option<&str>, vcodec: Option<&str>) -> String {
    let cap = match quality.unwrap_or("best") {
        "4k" => "[height<=2160]",
        "1440p" => "[height<=1440]",
        "1080p" => "[height<=1080]",
        "720p" => "[height<=720]",
        "480p" => "[height<=480]",
        "360p" => "[height<=360]",
        _ => "",
    };
    let codec = match vcodec.unwrap_or_default() {
        "h264" => "[vcodec^=avc1]",
        "av1" => "[vcodec^=av01]",
        "vp9" => "[vcodec^=vp9]",
        _ => "",
    };

    if !codec.is_empty() {
        return format!("bv*{codec}{cap}+ba/bv*{cap}+ba/b{cap}/best");
    }
    format!(
        "bv*[vcodec^=avc1]{cap}+ba[acodec^=mp4a]/bv*[ext=mp4]{cap}+ba[ext=m4a]/bv*{cap}+ba/b[ext=mp4]{cap}/b{cap}/best"
    )
}

pub fn audio_selector() -> String {
    "ba[ext=m4a]/ba/bestaudio/best".to_string()
}

fn quality_ladder(ceiling: i64) -> Vec<Value> {
    [
        ("best", "Best available", i64::MAX),
        ("4k", "4K · 2160p", 2160),
        ("1440p", "1440p", 1440),
        ("1080p", "1080p · Full HD", 1080),
        ("720p", "720p · HD", 720),
        ("480p", "480p", 480),
        ("360p", "360p", 360),
    ]
    .iter()
    .filter(|(_, _, h)| *h == i64::MAX || *h <= ceiling)
    .map(|(id, label, h)| json!({ "id": id, "label": label, "h": if *h == i64::MAX { Value::Null } else { json!(h) } }))
    .collect()
}

fn audio_formats() -> Vec<Value> {
    vec![
        json!({ "id": "mp3", "label": "MP3" }),
        json!({ "id": "m4a", "label": "M4A" }),
        json!({ "id": "opus", "label": "Opus" }),
        json!({ "id": "flac", "label": "FLAC (lossless)" }),
    ]
}
