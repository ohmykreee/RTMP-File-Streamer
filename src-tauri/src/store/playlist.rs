//! Playlist store: probe cache, sidecar subtitle discovery, persistence.
//! Port of `src/main/store/playlist.ts`.

use crate::ffmpeg::probe::{embedded_subtitle_refs, probe_media, probe_subtitle_file};
use crate::shared::i18n;
use crate::shared::types::{
    base_name, ext_name, MediaInfo, PlaylistItem, SubtitleMode, SubtitleTrackRef, SUPPORTED_SUBTITLE_EXT,
};
use crate::store::errors::report_store_error;
use crate::store::paths::{data_dir, ensure_dir};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static ID_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn new_id() -> String {
    let seq = ID_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    format!("it_{:x}_{:x}", now_millis(), seq)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ------------------------------------------------------------------ *
 * Probe cache
 * ------------------------------------------------------------------ */

struct CacheEntry {
    key: String,
    language: String,
    info: MediaInfo,
}

static PROBE_CACHE: Mutex<Option<HashMap<String, CacheEntry>>> = Mutex::new(None);
const PROBE_CACHE_LIMIT: usize = 64;

fn file_key(p: &str) -> String {
    match std::fs::metadata(p).and_then(|m| m.modified()) {
        Ok(modified) => {
            let mtime = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            format!("{}:{mtime}", std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        }
        Err(_) => "missing".to_string(),
    }
}

pub async fn probe_cached(ffprobe_path: &str, file_path: &str, language: Option<&str>) -> MediaInfo {
    let abs = crate::store::paths::resolve_path(file_path);
    let key = file_key(&abs);
    let lang = language.unwrap_or(crate::ffmpeg::probe::DEFAULT_PROBE_LANGUAGE).to_string();
    {
        let mut cache = PROBE_CACHE.lock().expect("probe cache lock");
        let map = cache.get_or_insert_with(HashMap::new);
        if let Some(hit) = map.get(&abs) {
            // A cached entry carries the error text it was probed with, so a
            // language switch has to invalidate it.
            if hit.key == key && hit.language == lang {
                return hit.info.clone();
            }
        }
    }
    let info = probe_media(ffprobe_path, &abs, &lang).await;
    if info.probe_error.is_none() {
        let mut cache = PROBE_CACHE.lock().expect("probe cache lock");
        let map = cache.get_or_insert_with(HashMap::new);
        map.insert(abs.clone(), CacheEntry { key, language: lang, info: info.clone() });
        while map.len() > PROBE_CACHE_LIMIT {
            let oldest = map.keys().next().cloned();
            match oldest {
                Some(k) => {
                    map.remove(&k);
                }
                None => break,
            }
        }
    }
    info
}

pub fn get_cached_media(file_path: &str) -> Option<MediaInfo> {
    let abs = crate::store::paths::resolve_path(file_path);
    let key = file_key(&abs);
    let mut cache = PROBE_CACHE.lock().expect("probe cache lock");
    let map = cache.get_or_insert_with(HashMap::new);
    let hit = map.get(&abs)?;
    if hit.key != key {
        map.remove(&abs);
        return None;
    }
    Some(hit.info.clone())
}

/* ------------------------------------------------------------------ *
 * Sidecar subtitle discovery
 * ------------------------------------------------------------------ */

/// How many leading characters the two cleaned names must share.
const SIDECAR_MIN_SHARED_CHARS: usize = 6;

/// The identifying part of a filename: everything before the first qualifier
/// token, lower-cased and without trailing separators.
pub fn stem_prefix(name: &str) -> String {
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default().to_lowercase();
    // The TS original ends the qualifier with the lookahead `(?=$|[._\-\s])`.
    // The `regex` crate does not support look-around and `Regex::new` would
    // fail (`.expect` panics, aborting the whole add-items command), so the
    // boundary is consumed instead. Only `m.start()` is read below, which a
    // trailing consuming group cannot move.
    let re = regex::Regex::new(r"(?i)(?:^|[._\-\s])(chs|cht|cn|zh|zho|chi|hans|hant|sc|tc|简体|繁体|简|繁|中文|双语|中英|英文|english|eng|jpn|jp|japanese|kor|kr|korean|forced|sdh|cc|full|default)(?:$|[._\-\s])")
        .expect("static regex");
    let end = re.find(&stem).map(|m| m.start()).unwrap_or(stem.len());
    stem[..end].trim_end_matches(['.', '_', '-', ' ']).to_string()
}

/// True when `subtitle_name` looks like a sidecar of `video_name`.
pub fn subtitle_matches_video(video_name: &str, subtitle_name: &str) -> bool {
    let video_stem = Path::new(video_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
        .to_lowercase();
    let video_stem = video_stem.trim_end_matches(['.', '_', '-', ' ']).to_string();
    let sub_stem = Path::new(subtitle_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
        .to_lowercase();
    if video_stem.is_empty() || sub_stem.is_empty() {
        return false;
    }
    if sub_stem == video_stem
        || sub_stem.starts_with(&format!("{video_stem}."))
        || sub_stem.starts_with(&format!("{video_stem}_"))
        || sub_stem.starts_with(&format!("{video_stem}-"))
    {
        return true;
    }
    let video_prefix = stem_prefix(video_name);
    let sub_prefix = stem_prefix(subtitle_name);
    if video_prefix.is_empty() || sub_prefix.is_empty() {
        return false;
    }
    let (shorter, longer) = if video_prefix.len() <= sub_prefix.len() {
        (&video_prefix, &sub_prefix)
    } else {
        (&sub_prefix, &video_prefix)
    };
    shorter.len() >= SIDECAR_MIN_SHARED_CHARS && longer.starts_with(shorter.as_str())
}

/// Sidecar subtitle files that belong to `videoPath`: a shared name prefix plus
/// any language/qualifier suffix, plus `Subs/`-style sibling folders.
pub fn find_sidecar_subtitles(video_path: &str) -> Vec<String> {
    let Some(dir) = Path::new(video_path).parent() else {
        return vec![];
    };
    let mut found: Vec<String> = Vec::new();
    scan_dir(dir, 1, video_path, &mut found);
    found
}

fn scan_dir(dir: &Path, depth: i32, video_path: &str, found: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let full = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if full.is_dir() {
            let re = regex::Regex::new(r"(?i)^(subs?|subtitles?|字幕)$").expect("static regex");
            if depth > 0 && re.is_match(&name) {
                scan_dir(&full, depth - 1, video_path, found);
            }
            continue;
        }
        let ext = ext_name(&name);
        if !SUPPORTED_SUBTITLE_EXT.contains(&ext.as_str()) {
            continue;
        }
        if subtitle_matches_video(video_path, &name) {
            found.push(full.to_string_lossy().into_owned());
        }
    }
}

/* ------------------------------------------------------------------ *
 * Item creation / mutation
 * ------------------------------------------------------------------ */

pub struct AddItemsResult {
    pub items: Vec<PlaylistItem>,
    pub errors: Vec<(String, String)>,
}

pub async fn create_playlist_items(ffprobe_path: &str, file_paths: &[String], defaults: (SubtitleMode, Option<String>)) -> AddItemsResult {
    let (mode, language) = defaults;
    let language = language.unwrap_or_else(|| crate::ffmpeg::probe::DEFAULT_PROBE_LANGUAGE.to_string());
    let mut items: Vec<PlaylistItem> = Vec::new();
    let mut errors: Vec<(String, String)> = Vec::new();

    for raw in file_paths {
        let file_path = crate::store::paths::resolve_path(raw);
        let size = match std::fs::metadata(&file_path) {
            Ok(m) => m.len(),
            Err(_) => {
                errors.push((
                    file_path,
                    i18n::t(&language, "main.dialog.probeMissing"),
                ));
                continue;
            }
        };

        let info = probe_cached(ffprobe_path, &file_path, Some(&language)).await;
        if info.probe_error.is_some() && info.streams.is_empty() {
            errors.push((file_path.clone(), info.probe_error.clone().unwrap_or_default()));
        }

        let mut tracks: Vec<SubtitleTrackRef> = embedded_subtitle_refs(&info);
        // Auto-attach sidecar subtitle files so "video + subtitles" needs one click.
        for sub_path in find_sidecar_subtitles(&file_path) {
            if let Some(reference) = probe_subtitle_file(ffprobe_path, &sub_path, &language).await {
                if !tracks.iter().any(|t| t.id == reference.id) {
                    tracks.push(reference);
                }
            }
        }

        let preferred = tracks.iter().find(|t| t.family == "text").or_else(|| tracks.first()).map(|t| t.id.clone());
        let name = base_name(&file_path);
        let final_mode = if tracks.is_empty() { "off".to_string() } else { mode.clone() };
        items.push(PlaylistItem {
            id: new_id(),
            path: file_path,
            name,
            size,
            duration_sec: info.duration_sec,
            subtitle_tracks: tracks,
            selected_subtitle_id: preferred,
            mode: final_mode,
            sync_offset_sec: 0.0,
            subtitle_delay_sec: 0.0,
            status: "pending".into(),
            error: None,
            broken: Some(info.probe_error.is_some() && info.streams.is_empty()),
        });
    }

    AddItemsResult { items, errors }
}

pub async fn attach_subtitle_file(ffprobe_path: &str, item: &PlaylistItem, sub_path: &str, language: Option<&str>) -> Option<SubtitleTrackRef> {
    match std::fs::metadata(sub_path) {
        Ok(m) if m.is_file() => {}
        _ => return None,
    }
    let resolved = crate::store::paths::resolve_path(sub_path);
    if let Some(existing) = item
        .subtitle_tracks
        .iter()
        .find(|t| t.source == "external" && t.path.as_deref().map(|p| crate::store::paths::resolve_path(p)) == Some(resolved.clone()))
    {
        return Some(existing.clone());
    }
    probe_subtitle_file(ffprobe_path, sub_path, language.unwrap_or(crate::ffmpeg::probe::DEFAULT_PROBE_LANGUAGE)).await
}

pub fn reorder_by_id(items: &[PlaylistItem], ordered_ids: &[String]) -> Vec<PlaylistItem> {
    let mut map: HashMap<String, PlaylistItem> = items.iter().map(|i| (i.id.clone(), i.clone())).collect();
    let mut next: Vec<PlaylistItem> = Vec::new();
    for id in ordered_ids {
        if let Some(item) = map.remove(id) {
            next.push(item);
        }
    }
    // Preserve anything the renderer did not mention.
    for leftover in map.into_values() {
        next.push(leftover);
    }
    next
}

/* ------------------------------------------------------------------ *
 * Persistence of the queue between sessions
 * ------------------------------------------------------------------ */

pub fn playlist_file() -> PathBuf {
    data_dir().join("playlist.json")
}

const SUBTITLE_MODES: [&str; 3] = ["off", "burn", "copy"];

fn finite_number(value: Option<f64>) -> f64 {
    value.unwrap_or(0.0)
}

/// One stored row, validated into a `PlaylistItem`; anything unusable is dropped.
fn normalise_stored_item(raw: &Value) -> Option<PlaylistItem> {
    let path = raw.get("path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty())?;
    let file_path = path.to_string();
    let mut tracks: Vec<SubtitleTrackRef> = Vec::new();
    if let Some(list) = raw.get("subtitleTracks").and_then(Value::as_array) {
        for t in list {
            let source = t.get("source").and_then(Value::as_str).unwrap_or_default();
            if source != "embedded" && source != "external" {
                continue;
            }
            let id = t.get("id").and_then(Value::as_str).filter(|s| !s.is_empty());
            let Some(id) = id else { continue };
            if source == "external" {
                // A sidecar that no longer exists must not stay selectable.
                let p = t.get("path").and_then(Value::as_str).unwrap_or_default();
                if p.is_empty() || !Path::new(p).exists() {
                    continue;
                }
            } else if t.get("streamIndex").and_then(Value::as_i64).is_none() {
                continue;
            }
            tracks.push(SubtitleTrackRef {
                id: id.to_string(),
                source: source.to_string(),
                path: t.get("path").and_then(Value::as_str).map(str::to_string),
                stream_index: t.get("streamIndex").and_then(Value::as_i64),
                codec: t.get("codec").and_then(Value::as_str).unwrap_or("unknown").to_string(),
                family: match t.get("family").and_then(Value::as_str) {
                    Some("text") | Some("bitmap") => t["family"].as_str().expect("checked").to_string(),
                    _ => "unknown".into(),
                },
                language: t.get("language").and_then(Value::as_str).map(str::to_string),
                title: t.get("title").and_then(Value::as_str).map(str::to_string),
                is_default: t.get("isDefault").and_then(Value::as_bool),
                is_forced: t.get("isForced").and_then(Value::as_bool),
            });
        }
    }
    let selected_raw = raw.get("selectedSubtitleId").and_then(Value::as_str);
    let selected = selected_raw.filter(|id| tracks.iter().any(|t| &t.id == id)).map(str::to_string);
    let mode = match raw.get("mode").and_then(Value::as_str) {
        Some(m) if SUBTITLE_MODES.contains(&m) => m.to_string(),
        _ => "off".into(),
    };
    let exists = Path::new(&file_path).exists();
    let final_mode = if !tracks.is_empty() { mode } else { "off".to_string() };
    Some(PlaylistItem {
        id: raw
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(new_id),
        path: file_path.clone(),
        name: raw
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| base_name(&file_path)),
        size: finite_number(raw.get("size").and_then(Value::as_f64)).max(0.0) as u64,
        duration_sec: finite_number(raw.get("durationSec").and_then(Value::as_f64)).max(0.0),
        subtitle_tracks: tracks,
        selected_subtitle_id: selected,
        mode: final_mode,
        sync_offset_sec: finite_number(raw.get("syncOffsetSec").and_then(Value::as_f64)),
        subtitle_delay_sec: finite_number(raw.get("subtitleDelaySec").and_then(Value::as_f64)),
        // Nothing is "live" after a restart.
        status: "pending".into(),
        error: None,
        broken: Some(!exists).filter(|b| *b),
    })
}

pub fn load_persisted_playlist() -> Vec<PlaylistItem> {
    let file = playlist_file();
    let Ok(raw) = std::fs::read_to_string(&file) else {
        return vec![]; // ENOENT is the normal first-launch case
    };
    let parsed: Result<Value, _> = serde_json::from_str(&raw);
    match parsed {
        Ok(v) => {
            let Some(items) = v.get("items").and_then(Value::as_array) else {
                return vec![];
            };
            items.iter().filter_map(normalise_stored_item).collect()
        }
        Err(err) => {
            let renamed = format!("{}.corrupt-{}", file.to_string_lossy(), now_millis());
            let _ = std::fs::rename(&file, &renamed);
            report_store_error("playlist", &err.to_string());
            vec![]
        }
    }
}

pub fn persist_playlist(items: &[PlaylistItem]) {
    let file = playlist_file();
    if !ensure_dir(file.parent().unwrap_or(&data_dir())) {
        report_store_error("playlist", "Data directory is not writable");
        return;
    }
    let tmp = file.with_extension("json.tmp");
    let payload = json!({ "items": items });
    let result = serde_json::to_string_pretty(&payload)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(&tmp, s).map_err(|e| e.to_string()))
        .and_then(|()| std::fs::rename(&tmp, &file).map_err(|e| e.to_string()));
    if let Err(err) = result {
        report_store_error("playlist", &err);
    }
}
