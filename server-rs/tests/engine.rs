//! The extraction bridge against the real engine.
//!
//! These need the binary and the network, so they are `#[ignore]`d and run on
//! purpose:
//!
//!   cargo test --test engine -- --ignored --nocapture
//!
//! What they are for is the class of bug unit tests cannot see: the engine
//! answering in bytes that are not UTF-8, in the console code page, with colour
//! codes, or not at all. The first version of `run` silently discarded every
//! answer containing one such byte and reported success with nothing in it.

use velox_license::extract::{audio_selector, video_selector, Extractor, Selection};

const LINK: &str = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

fn engine() -> Extractor {
    Extractor::from_env(Some(std::path::Path::new("../bin")))
}

// -------------------------------------------------- no engine needed for these

#[test]
fn the_quality_asked_for_is_the_quality_selected() {
    let sel = video_selector(Some("1080p"), None);
    assert!(sel.contains("height<=1080"), "{sel}");
    assert!(sel.contains("bv*") && sel.contains("+ba"), "video and audio are taken separately: {sel}");
    assert!(sel.ends_with("/best"), "there is always a fallback: {sel}");

    // Above 720p YouTube only has adaptive streams, so asking for one file
    // silently hands back 720p. The selector must prefer the pair.
    assert!(video_selector(Some("4k"), None).starts_with("bv*"));
    assert!(video_selector(Some("best"), None).contains("bv*"));
    assert!(!video_selector(Some("best"), None).contains("height<="), "Best has no ceiling");

    assert!(video_selector(Some("1080p"), Some("av1")).contains("av01"));
    assert!(audio_selector().starts_with("ba"));
}

// ------------------------------------------------------- the engine itself

#[tokio::test]
#[ignore = "needs the engine binary and the network"]
async fn a_real_link_reads_back_with_a_menu() {
    let out = engine().probe(LINK).await;
    assert_eq!(out["ok"], serde_json::json!(true), "{out}");
    assert!(!out["meta"]["title"].as_str().unwrap_or_default().is_empty());
    assert!(out["meta"]["maxHeight"].as_i64().unwrap_or(0) >= 720);
    let ladder = out["videoOptions"].as_array().expect("a ladder of qualities");
    assert!(ladder.len() >= 4, "{ladder:?}");
    assert_eq!(out["audioOptions"].as_array().map(Vec::len), Some(4));
}

#[tokio::test]
#[ignore = "needs the engine binary and the network"]
async fn a_chosen_quality_comes_back_as_urls_the_client_can_fetch() {
    let out = engine()
        .resolve(LINK, &Selection { quality: Some("720p".into()), ..Default::default() })
        .await;
    assert_eq!(out["ok"], serde_json::json!(true), "{out}");
    let streams = out["streams"].as_array().expect("at least one stream");
    assert!(!streams.is_empty());
    assert!(streams.iter().all(|s| s.as_str().unwrap_or_default().starts_with("http")));
    assert_eq!(out["container"], serde_json::json!("mp4"));
    assert!(!out["headers"]["Referer"].as_str().unwrap_or_default().is_empty(), "CDNs want the page");
}

#[tokio::test]
#[ignore = "needs the engine binary and the network"]
async fn audio_comes_back_as_one_stream_needing_no_merge() {
    let out = engine()
        .resolve(LINK, &Selection { mode: Some("audio".into()), aformat: Some("mp3".into()), ..Default::default() })
        .await;
    assert_eq!(out["ok"], serde_json::json!(true), "{out}");
    assert_eq!(out["mode"], serde_json::json!("audio"));
    assert_eq!(out["needsMerge"], serde_json::json!(false));
    assert_eq!(out["container"], serde_json::json!("mp3"));
}

#[tokio::test]
#[ignore = "needs the engine binary"]
async fn the_site_list_survives_names_that_are_not_ascii() {
    // The regression this file exists for: ~1700 site names, some of them in
    // other scripts, so the answer is not valid UTF-8 on Windows.
    let out = engine().list_sites().await;
    assert_eq!(out["ok"], serde_json::json!(true), "{out}");
    let list = out["list"].as_array().expect("a list");
    assert!(list.len() > 500, "the engine supports far more than {} sites", list.len());
    assert!(
        list.iter().all(|s| !s.as_str().unwrap_or_default().contains('\u{1b}')),
        "no colour codes reach the app"
    );
    assert!(
        list.iter().any(|s| s.as_str() == Some("youtube")),
        "the one site every customer arrives with is in there"
    );
}

#[tokio::test]
#[ignore = "needs the engine binary and the network"]
async fn a_search_comes_back_as_playable_items() {
    let out = engine().search("blender open movie", Some(5)).await;
    assert_eq!(out["ok"], serde_json::json!(true), "{out}");
    let items = out["items"].as_array().expect("results");
    assert!(!items.is_empty() && items.len() <= 5);
    for item in items {
        assert!(item["url"].as_str().unwrap_or_default().starts_with("http"), "{item}");
        assert!(!item["title"].as_str().unwrap_or_default().is_empty());
        assert!(item["thumbnail"].as_str().unwrap_or_default().starts_with("http"));
    }
}

// ------------------------------------------------------------- what it says

#[tokio::test]
async fn a_link_that_is_not_a_link_is_refused_without_starting_anything() {
    let ex = engine();
    for bad in ["", "   ", "not a url", "javascript:alert(1)", "file:///etc/passwd"] {
        let out = ex.probe(bad).await;
        assert_eq!(out["ok"], serde_json::json!(false), "{bad} should be refused");
        let resolved = ex.resolve(bad, &Selection::default()).await;
        assert_eq!(resolved["ok"], serde_json::json!(false), "{bad} should be refused");
    }
}

#[tokio::test]
#[ignore = "needs the engine binary and the network"]
async fn a_failure_never_names_the_engine() {
    // A customer should never have to learn what the server runs, whether the
    // message comes from us or from the engine's own stderr.
    let out = engine().probe("https://www.youtube.com/watch?v=velox-no-such-video").await;
    assert_eq!(out["ok"], serde_json::json!(false), "{out}");
    let message = out["error"].as_str().unwrap_or_default().to_lowercase();
    assert!(!message.is_empty());
    assert!(!message.contains("yt-dlp") && !message.contains("yt_dlp"), "{message}");
}
