//! Editable site content + the admin lock that guards it.
//!
//! Everything the public page shows - headlines, features, price, links - lives
//! in one JSON document that the owner edits at /Admin. The public site reads it
//! anonymously; only a logged-in admin can write it. Nothing here is compiled
//! into the React bundle, so copy changes never need a rebuild or a deploy.

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What a brand-new install shows before the owner edits anything. Real copy,
/// not placeholders - the site is presentable the moment it boots.
pub fn default_content() -> Value {
    json!({
        "brand": {
            "name": "Velox Downloader",
            "tagline": "1-click video downloader",
            "version": "2.4",
            "osBadge": "v2.4 for Windows"
        },
        "nav": {
            "links": [
                { "label": "Features", "href": "#features" },
                { "label": "How It Works", "href": "#how" },
                { "label": "Extension", "href": "#extension" },
                { "label": "Pricing", "href": "#pricing" },
                { "label": "Help", "href": "/help" },
                { "label": "FAQ", "href": "#faq" }
            ],
            "cta": "Download Free"
        },
        // The help centre. The app's Get help button opens #help, so this is
        // where a stuck customer lands - which is why it is editable here and
        // not compiled into the page: an answer can go up while someone is
        // still waiting for it.
        //
        // An article shows a picture or a video, never both: whichever is
        // filled in wins, and a video's thumbnail comes from YouTube so a guide
        // looks finished without anyone making artwork for it.
        "help": {
            "heading": "Help Center",
            "sub": "Short answers to the things people ask most. Every guide takes a minute.",
            "articles": [
                {
                    "title": "Activating Velox on your PC",
                    "description": "Enter your email twice, tick the box, and the key arrives in your inbox. The licence locks to this computer, so use the machine you will actually download on.",
                    "image": "",
                    "video": ""
                },
                {
                    "title": "Why my key will not work on a second computer",
                    "description": "A licence is tied to one machine's hardware. Reinstalling Windows or the app is fine - the same PC stays the same PC. A new motherboard counts as a new machine; message us and we will move it.",
                    "image": "",
                    "video": ""
                },
                {
                    "title": "Downloading a whole playlist",
                    "description": "Paste the playlist link, or search and press Open playlist. Pick the episodes you want, choose video or MP3, and each one is queued as its own download.",
                    "image": "",
                    "video": ""
                },
                {
                    "title": "Torrents: picking files before they download",
                    "description": "Add a magnet or a .torrent file and Velox reads the file list first. Tick only what you want - language packs and extras can stay behind - then press Start download.",
                    "image": "",
                    "video": ""
                }
            ]
        },
        "hero": {
            "headline": "Download Any Video in 1-Click.",
            "headlineAccent": "Up to 8K Quality.",
            "sub": "High-speed desktop downloader with instant browser stream interception. No copy-pasting required.",
            "primaryCta": "Download for Windows",
            "downloadUrl": "/download/VeloxDownloader.exe",
            "secondaryCta": "Get Chrome / Firefox Extension",
            "secondaryUrl": "#extension",
            "micro": "Version 2.4  |  100% Clean: No Ads, No Bundled Malware."
        },
        "ecosystems": {
            "label": "Works everywhere you already watch",
            "platforms": ["YouTube", "Facebook", "Instagram", "TikTok", "Twitter / X", "Vimeo", "Twitch"],
            "browsers": ["Chrome", "Edge", "Firefox", "Brave", "Opera"]
        },
        "injection": {
            "eyebrow": "The 1-Click Injection Engine",
            "title": "The extension finds the stream. The app grabs it.",
            "sub": "Velox watches the page for media as it loads, so there is nothing to copy and nothing to paste. Hit the badge and the download is already running on your desktop.",
            "steps": [
                { "title": "A video starts playing", "body": "The extension sees the stream request the moment the player asks for it." },
                { "title": "A Download badge appears", "body": "A floating glass badge fades in over the player - no menus, no right-clicking." },
                { "title": "One click hands it over", "body": "The link, referer and chosen quality transfer straight to the desktop app and start." }
            ],
            "specs": ["Automatic m3u8 / HLS stream detection", "Dynamic resolution switching", "DASH manifest support", "Works inside iframes"]
        },
        "capabilities": [
            { "icon": "01", "title": "Multi-thread Turbo", "body": "Downloads are split across parallel connections - up to 10x faster than a single stream." },
            { "icon": "02", "title": "8K to MP3", "body": "8K, 4K and 1080p MP4 video, plus high-bitrate 320kbps MP3 audio extraction." },
            { "icon": "03", "title": "Batch Grabber", "body": "Full playlists, whole channels, and an unlimited queue - all in one go." },
            { "icon": "04", "title": "Private by design", "body": "No tracking, zero logs, encrypted direct connection. Your files never touch our servers." }
        ],
        "howItWorks": {
            "heading": "Three steps, then it is yours",
            "steps": [
                { "n": "01", "title": "Install", "body": "Install the desktop app and enable the browser extension. One tick, one restart." },
                { "n": "02", "title": "Browse", "body": "Open any site and hit the floating grab button that appears over the video." },
                { "n": "03", "title": "Save", "body": "Pick 4K, 1080p or audio-only and it saves straight to disk." }
            ]
        },
        "pricing": {
            "heading": "Free to try. Pro when you need the ceiling lifted.",
            "sub": "The free version is genuinely useful. Pro removes every limit and unlocks the full injection engine.",
            "price": "19.99",
            "currency": "USD",
            "period": "per year",
            "product": "Velox Downloader Pro - 1 year licence",
            "freeLabel": "Free Version",
            "proLabel": "Pro License",
            "rows": [
                { "feature": "Max Resolution", "free": "1080p FHD", "pro": "Up to 8K Ultra HD" },
                { "feature": "Browser Extension", "free": "Basic Detection", "pro": "Advanced Stream Injection (HLS/DASH)" },
                { "feature": "Batch / Playlist", "free": "Up to 3 links", "pro": "Unlimited links & Full Playlists" },
                { "feature": "Download Speed", "free": "Standard", "pro": "Uncapped Multi-thread Turbo" },
                { "feature": "Audio Converter", "free": "128 kbps MP3", "pro": "320 kbps High-Res MP3/WAV" }
            ],
            "cta": "Get Pro"
        },
        "trust": {
            "heading": "Safe to install",
            "badges": ["VirusTotal Clean Report", "Microsoft SmartScreen Verified", "Apple Notarized"]
        },
        "faq": [
            {
                "q": "Does the extension work without the desktop app?",
                "a": "No - the desktop client has to be running in the background. The extension only detects the stream and hands it over; the app does the downloading, using your own bandwidth."
            },
            {
                "q": "How do I download a whole YouTube playlist at once?",
                "a": "Paste the playlist URL into the desktop app and every video in it is queued automatically. On the Free version the queue stops at 3 links; Pro removes that limit."
            },
            {
                "q": "What is the legal policy?",
                "a": "Velox is for personal backup and offline viewing of content you have the right to keep. Respect each platform's terms of service and the rights of the people who made the thing you are saving."
            },
            {
                "q": "Which sites are supported?",
                "a": "Over a thousand, including YouTube, Facebook, Instagram, TikTok, Twitter/X, Vimeo and Twitch. The engine updates itself as sites change."
            }
        ],
        "footer": {
            "links": [
                { "label": "Documentation", "href": "#" },
                { "label": "Extension install guide", "href": "#extension" },
                { "label": "Changelog", "href": "#" },
                { "label": "Contact / Support", "href": "#" }
            ],
            "copyright": "The Hard Worker Corporation",
            "disclaimer": "Terms of Service and Fair Use Policy: Velox is intended for personal backup and offline viewing. Only download content you have the right to download."
        }
    })
}

pub fn content_file(dir: &str) -> PathBuf {
    PathBuf::from(dir).join("content.json")
}

pub fn load_content(dir: &str) -> Value {
    std::fs::read_to_string(content_file(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(default_content)
}

pub fn save_content(dir: &str, content: &Value) -> Result<(), String> {
    let path = content_file(dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(content).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// The price the buyer is actually charged. Read from the edited content so the
/// owner can change it at /Admin, but re-validated here - a malformed or absurd
/// value falls back to the env price rather than reaching PayPal.
pub fn price_from(content: &Value, fallback: &str) -> String {
    let raw = content
        .pointer("/pricing/price")
        .and_then(|p| p.as_str())
        .unwrap_or(fallback)
        .trim();

    match raw.parse::<f64>() {
        Ok(n) if n > 0.0 && n < 100_000.0 => format!("{n:.2}"),
        _ => fallback.to_string(),
    }
}

pub fn currency_from(content: &Value, fallback: &str) -> String {
    let raw = content
        .pointer("/pricing/currency")
        .and_then(|c| c.as_str())
        .unwrap_or(fallback)
        .trim()
        .to_uppercase();
    // PayPal currency codes are three letters; anything else is a typo.
    if raw.len() == 3 && raw.chars().all(|c| c.is_ascii_alphabetic()) {
        raw
    } else {
        fallback.to_uppercase()
    }
}

pub fn product_from(content: &Value, fallback: &str) -> String {
    content
        .pointer("/pricing/product")
        .and_then(|p| p.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .chars()
        .take(120)
        .collect()
}

// ------------------------------------------------------------- admin sessions

/// In-memory admin sessions. Losing them on restart is the correct trade-off:
/// a restart logs the owner out, which is what you want from an admin surface.
#[derive(Default)]
pub struct Sessions {
    tokens: HashMap<String, u64>,
}

const SESSION_MS: u64 = 8 * 60 * 60 * 1000; // 8 hours

impl Sessions {
    pub fn issue(&mut self) -> String {
        self.sweep();
        let token = format!(
            "{:016x}{:016x}{:016x}",
            rand::random::<u64>(),
            rand::random::<u64>(),
            rand::random::<u64>()
        );
        self.tokens.insert(token.clone(), now_ms() + SESSION_MS);
        token
    }

    pub fn valid(&mut self, token: &str) -> bool {
        self.sweep();
        self.tokens.get(token).map(|exp| *exp > now_ms()).unwrap_or(false)
    }

    pub fn revoke(&mut self, token: &str) {
        self.tokens.remove(token);
    }

    fn sweep(&mut self) {
        let now = now_ms();
        self.tokens.retain(|_, exp| *exp > now);
    }
}

/// Constant-time-ish comparison so the admin password can't be guessed by
/// timing how long a wrong answer takes.
pub fn secret_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}
