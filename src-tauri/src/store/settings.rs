//! `<app>/Data/settings.json` — load/merge/save with the same semantics as
//! `src/main/store/settings.ts`: stored values merge over the defaults so keys
//! added in a newer version still resolve, numeric settings are clamped into
//! the ranges the command builder assumes, and the protocol decides the
//! network transport and container.

use crate::shared::defaults::{BUFFER_SEC_DEFAULT, BUFFER_SEC_MAX, BUFFER_SEC_MIN, OBS_PORT_MAX, OBS_PORT_MIN};
use crate::shared::i18n::{detect_language, is_language, resolve_language};
use crate::shared::protocol::{container_for_protocol, network_for_protocol, STREAM_PROTOCOLS};
use crate::shared::types::{AppSettings, THEME_PREFERENCES};
use crate::store::errors::report_store_error;
use crate::store::paths::data_dir;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, OnceLock};

fn settings_file() -> PathBuf {
    data_dir().join("settings.json")
}

/// The language the operating system is set to. A `--lang` command line
/// override (used by the e2e suites, mirroring Electron's Chromium switch)
/// wins over the OS UI language.
pub fn get_system_locale() -> String {
    static LOCALE: OnceLock<String> = OnceLock::new();
    LOCALE
        .get_or_init(|| {
            for arg in std::env::args().skip(1) {
                if let Some(value) = arg.strip_prefix("--lang=") {
                    return value.to_string();
                }
                if arg == "--lang" {
                    // `--lang zh-CN` two-token form.
                    if let Some(next) = std::env::args().nth(2) {
                        return next;
                    }
                }
            }
            sys_locale::get_locale().unwrap_or_default()
        })
        .clone()
}

/* ------------------------------------------------------------------ *
 * JSON-level spread helpers (the TS builders' `{ ...a, ...b }` semantics)
 * ------------------------------------------------------------------ */

fn as_object(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn spread(base: &Value, over: &Value) -> Value {
    if !over.is_object() {
        return base.clone();
    }
    let mut merged = as_object(base);
    for (k, v) in as_object(over) {
        merged.insert(k, v);
    }
    Value::Object(merged)
}

fn get_string(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn get_bool(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(|x| x.as_bool())
}

fn get_number(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

fn clamp_number(value: Option<f64>, min: f64, max: f64, fallback: f64) -> f64 {
    match value {
        Some(n) if n.is_finite() => n.min(max).max(min),
        _ => fallback,
    }
}

fn defaults_json() -> &'static Value {
    static DEFAULTS: LazyLock<Value> = LazyLock::new(|| {
        serde_json::to_value(&*crate::shared::defaults::default_settings()).expect("typed defaults serialize")
    });
    &DEFAULTS
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

fn normalise_video(v: &Value) -> Value {
    let defaults = defaults_json();
    let dv = &defaults["session"]["video"];
    let mut out = v.clone();
    let set = |out: &mut Value, key: &str, value: Value| {
        if let Some(obj) = out.as_object_mut() {
            obj.insert(key.into(), value);
        }
    };
    let clamp = |key: &str, min: f64, max: f64| {
        get_number(v, key)
            .map(|n| clamp_number(Some(n), min, max, get_number(dv, key).unwrap_or(0.0)).round())
            .unwrap_or_else(|| get_number(dv, key).unwrap_or(0.0))
    };
    set(&mut out, "bitrateKbps", clamp("bitrateKbps", 100.0, 100_000.0).into());
    set(&mut out, "maxBitrateKbps", clamp("maxBitrateKbps", 100.0, 100_000.0).into());
    set(&mut out, "bufferSizeKbps", clamp("bufferSizeKbps", 0.0, 200_000.0).into());
    set(&mut out, "crf", clamp("crf", 0.0, 51.0).into());
    set(&mut out, "fps", clamp("fps", 0.0, 240.0).into());
    set(&mut out, "keyframeIntervalSec", clamp("keyframeIntervalSec", 0.0, 10.0).into());
    set(&mut out, "bFrames", clamp("bFrames", 0.0, 4.0).into());
    set(&mut out, "scaleWidth", clamp("scaleWidth", 2.0, 7680.0).into());
    set(&mut out, "scaleHeight", clamp("scaleHeight", 2.0, 4320.0).into());
    set(&mut out, "preset", get_string(v, "preset").unwrap_or_default().into());
    set(&mut out, "tune", get_string(v, "tune").unwrap_or_default().into());
    set(&mut out, "profile", get_string(v, "profile").unwrap_or_default().into());
    set(&mut out, "pixelFormat", get_string(v, "pixelFormat").unwrap_or_else(|| "yuv420p".into()).into());
    out
}

fn normalise_audio(a: &Value) -> Value {
    let defaults = defaults_json();
    let da = &defaults["session"]["audio"];
    let mut out = a.clone();
    let sample_rates = [22050.0, 32000.0, 44100.0, 48000.0];
    let sample_rate = match get_number(a, "sampleRate") {
        Some(sr) if sample_rates.contains(&sr) => sr,
        _ => get_number(da, "sampleRate").unwrap_or(44100.0),
    };
    let mut set = |key: &str, value: Value| {
        if let Some(obj) = out.as_object_mut() {
            obj.insert(key.into(), value);
        }
    };
    set(
        "bitrateKbps",
        clamp_number(get_number(a, "bitrateKbps"), 16.0, 512.0, get_number(da, "bitrateKbps").unwrap_or(160.0))
            .round()
            .into(),
    );
    set("sampleRate", sample_rate.into());
    set(
        "channels",
        clamp_number(get_number(a, "channels"), 1.0, 2.0, get_number(da, "channels").unwrap_or(2.0))
            .round()
            .into(),
    );
    out
}

/// Normalises the output block. The buffered playout is selected by `buffered`
/// alone; `bufferSec` is clamped into the range the engine accepts. The
/// protocol decides the transport and the container outright (a settings file
/// written before the protocol existed carries a `container` choice that is no
/// longer free — it is overwritten, not merged).
pub fn normalise_output(raw: &Value) -> Value {
    let defaults = defaults_json();
    let fallback = &defaults["session"]["output"];
    // An address the user emptied stays empty; a *missing* value falls back.
    let server = get_string(raw, "server").unwrap_or_else(|| get_string(fallback, "server").unwrap_or_default());
    let obs = spread(&fallback["obsWebSocket"], &raw["obsWebSocket"]);
    let buffered = get_bool(raw, "buffered")
        .unwrap_or_else(|| get_bool(fallback, "buffered").unwrap_or(true));
    let delay = clamp_number(get_number(raw, "bufferSec"), BUFFER_SEC_MIN, BUFFER_SEC_MAX, BUFFER_SEC_DEFAULT);
    let protocol = match get_string(raw, "protocol") {
        Some(p) if STREAM_PROTOCOLS.contains(&p.as_str()) => p,
        _ => get_string(fallback, "protocol").unwrap_or_else(|| "rtmp".into()),
    };

    let mut out = spread(fallback, raw);
    let mut set = |key: &str, value: Value| {
        if let Some(obj) = out.as_object_mut() {
            obj.insert(key.into(), value);
        }
    };
    set("server", server.into());
    set("streamKey", get_string(raw, "streamKey").unwrap_or_default().into());
    set("protocol", protocol.clone().into());
    set("network", network_for_protocol(Some(&protocol), get_string(raw, "network").as_deref()).into());
    set(
        "container",
        container_for_protocol(Some(&protocol))
            .unwrap_or_else(|| get_string(fallback, "container").unwrap_or_else(|| "flv".into()))
            .into(),
    );
    set("buffered", buffered.into());
    set("bufferSec", delay.into());
    set(
        "obsWebSocket",
        serde_json::json!({
            "enabled": get_bool(&obs, "enabled").unwrap_or(false),
            "host": match get_string(&obs, "host") {
                Some(h) if !h.trim().is_empty() => h.trim().to_string(),
                _ => get_string(&fallback["obsWebSocket"], "host").unwrap_or_else(|| "127.0.0.1".into()),
            },
            "port": clamp_number(get_number(&obs, "port"), OBS_PORT_MIN, OBS_PORT_MAX, get_number(&fallback["obsWebSocket"], "port").unwrap_or(4455.0)).round(),
            "password": get_string(&obs, "password").unwrap_or_default(),
        }),
    );
    out
}

/// Merge stored values over the defaults so keys added in a newer version still
/// resolve, and so a partially written file cannot break startup.
pub fn merge_settings(stored: Option<&Value>) -> AppSettings {
    let defaults = defaults_json();
    let empty = Value::Object(Map::new());
    let s = stored.unwrap_or(&empty);

    let session_stored = &s["session"];
    let session_base = spread(&defaults["session"], session_stored);
    let output_raw = if session_stored.get("output").map(Value::is_object).unwrap_or(false) {
        session_stored["output"].clone()
    } else {
        defaults["session"]["output"].clone()
    };

    // `languageSet` distinguishes "the user chose this" from "this is what the
    // system locale was last time". A stored file written before the field
    // existed carries a language but no flag, which is treated as an explicit
    // choice for migration.
    let language_set = match get_bool(s, "languageSet") {
        Some(b) => b,
        None => get_string(s, "language").map(|l| is_language(&l)).unwrap_or(false),
    };
    let locale = get_system_locale();
    let language = if language_set {
        resolve_language(&get_string(s, "language").unwrap_or_default(), Some(&locale))
    } else {
        detect_language(Some(&locale))
    };

    let theme = match get_string(s, "theme") {
        Some(t) if THEME_PREFERENCES.contains(&t.as_str()) => t,
        _ => get_string(&defaults, "theme").unwrap_or_else(|| "system".into()),
    };
    let playlist_width = clamp_number(
        get_number(s, "playlistWidthPercent"),
        12.0,
        55.0,
        get_number(&defaults, "playlistWidthPercent").unwrap_or(27.0),
    );

    let merged = serde_json::json!({
        "ffmpegPath": get_string(s, "ffmpegPath").unwrap_or_default(),
        "ffprobePath": get_string(s, "ffprobePath").unwrap_or_default(),
        "debugLogging": get_bool(s, "debugLogging").unwrap_or_else(|| get_bool(&defaults, "debugLogging").unwrap_or(false)),
        "language": language,
        "languageSet": language_set,
        "theme": theme,
        "playlistWidthPercent": playlist_width,
        "session": {
            "video": normalise_video(&spread(&defaults["session"]["video"], &session_base["video"])),
            "audio": normalise_audio(&spread(&defaults["session"]["audio"], &session_base["audio"])),
            "subtitles": spread(&defaults["session"]["subtitles"], &session_base["subtitles"]),
            "output": normalise_output(&output_raw),
        },
    });
    serde_json::from_value(merged).expect("merged settings deserialize")
}

static CACHE: Mutex<Option<AppSettings>> = Mutex::new(None);

pub fn load_settings() -> AppSettings {
    if let Some(cached) = CACHE.lock().expect("settings cache lock").clone() {
        return cached;
    }
    let file = settings_file();
    let parsed = std::fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    match parsed {
        Some(parsed) => {
            let merged = merge_settings(Some(&parsed));
            *CACHE.lock().expect("settings cache lock") = Some(merged.clone());
            merged
        }
        None => {
            let fallback = merge_settings(None);
            *CACHE.lock().expect("settings cache lock") = Some(fallback.clone());
            if file.exists() {
                // Keep the unreadable file for diagnosis instead of silently
                // overwriting it with defaults on the next save.
                let renamed = format!("{}.corrupt-{}", file.to_string_lossy(), now_millis());
                let _ = std::fs::rename(&file, &renamed);
                report_store_error("settings", "settings.json is unreadable and was set aside");
            }
            fallback
        }
    }
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn save_settings(patch: Value) -> AppSettings {
    let current = load_settings();
    let current_json = serde_json::to_value(&current).expect("settings serialize");

    // A patch is a delta, not a replacement: per-section spread, matching the
    // TS `saveSettings` merge exactly.
    let patch_obj = as_object(&patch);
    let defined: Value = Value::Object(patch_obj); // missing keys are the "undefined" of JSON
    let session_patch = &defined["session"];

    let mut session = spread(&current_json["session"], session_patch);
    let video = spread(&current_json["session"]["video"], &session_patch["video"]);
    let audio = spread(&current_json["session"]["audio"], &session_patch["audio"]);
    let subtitles = spread(&current_json["session"]["subtitles"], &session_patch["subtitles"]);
    let mut output = spread(&current_json["session"]["output"], &session_patch["output"]);
    let obs = spread(&current_json["session"]["output"]["obsWebSocket"], &session_patch["output"]["obsWebSocket"]);
    if let Some(obj) = output.as_object_mut() {
        obj.insert("obsWebSocket".into(), obs);
    }
    if let Some(obj) = session.as_object_mut() {
        obj.insert("video".into(), video);
        obj.insert("audio".into(), audio);
        obj.insert("subtitles".into(), subtitles);
        obj.insert("output".into(), output);
    }

    // `languageSet` records a deliberate choice: only a patch that actually
    // carries a language may change it.
    let current_language_set = current.language_set;
    let language_set = match get_bool(&defined, "languageSet") {
        Some(b) => b,
        None => {
            if defined.get("language").is_some() {
                true
            } else {
                current_language_set
            }
        }
    };

    let mut combined = spread(&current_json, &defined);
    if let Some(obj) = combined.as_object_mut() {
        obj.insert("session".into(), session);
        obj.insert("languageSet".into(), language_set.into());
    }
    let next = merge_settings(Some(&combined));
    *CACHE.lock().expect("settings cache lock") = Some(next.clone());
    let file = settings_file();
    if crate::store::paths::ensure_dir(file.parent().unwrap_or(&data_dir())) {
        let tmp = file.with_extension("json.tmp");
        let result = serde_json::to_string_pretty(&next)
            .map_err(|e| e.to_string())
            .and_then(|s| std::fs::write(&tmp, s).map_err(|e| e.to_string()))
            .and_then(|()| std::fs::rename(&tmp, &file).map_err(|e| e.to_string()));
        match result {
            Ok(()) => {}
            Err(err) => {
                // The cache has already changed, so the UI would show "saved" and
                // lose it on restart. Surface the failure instead of only writing
                // to the console.
                report_store_error("settings", &err.to_string());
            }
        }
    } else {
        report_store_error("settings", "Data directory is not writable");
    }
    next
}

pub fn get_settings_path() -> String {
    settings_file().to_string_lossy().into_owned()
}

/// The active interface language, read through the settings so the two can
/// never disagree.
pub fn get_language() -> String {
    load_settings().language
}

/// Records an explicit language choice: writes both the language and
/// `languageSet` so the choice stops following the system locale.
pub fn set_language(language: &str) -> AppSettings {
    save_settings(serde_json::json!({ "language": language, "languageSet": true }))
}
