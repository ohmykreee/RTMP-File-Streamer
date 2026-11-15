//! Presets store. Port of `src/main/store/presets.ts`. The RTMP destination and
//! stream key ARE part of a preset and are stored in plain text by design.

use crate::shared::defaults::{builtin_presets, default_settings};
use crate::shared::types::{Preset, PresetLocation, SessionSettings};
use crate::store::errors::report_store_error;
use crate::store::paths::{app_root, data_dir, ensure_dir};
use crate::store::settings::normalise_output;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

/// Presets live beside the other state files in `<app>/Data`.
pub fn get_presets_file() -> PathBuf {
    data_dir().join("presets.json")
}

const FILE_VERSION: f64 = 1.0;

static CACHE: Mutex<Option<Vec<Preset>>> = Mutex::new(None);

fn new_preset_id() -> String {
    let rand: u32 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("p_{:x}_{:05x}", now_millis(), rand % 0xfffff)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Normalises a stored preset so missing keys fall back to the defaults.
fn normalise(raw: &Value) -> Option<Preset> {
    let name = raw.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty())?;
    let s = raw.get("settings").cloned().unwrap_or_else(|| Value::Object(Default::default()));
    let d = defaults();
    let settings: SessionSettings = serde_json::from_value(json!({
        "video": merge_over(d.get("video").unwrap_or(&Value::Null), s.get("video").unwrap_or(&Value::Null)),
        "audio": merge_over(d.get("audio").unwrap_or(&Value::Null), s.get("audio").unwrap_or(&Value::Null)),
        "subtitles": merge_over(d.get("subtitles").unwrap_or(&Value::Null), s.get("subtitles").unwrap_or(&Value::Null)),
        "output": normalise_output(s.get("output").unwrap_or(&Value::Null)),
    }))
    .ok()?;
    Some(Preset {
        id: raw
            .get("id")
            .and_then(Value::as_str)
            .filter(|i| !i.is_empty())
            .map(str::to_string)
            .unwrap_or_else(new_preset_id),
        name: name.chars().take(80).collect(),
        saved_at: Some(raw.get("savedAt").and_then(Value::as_f64).unwrap_or_else(|| now_millis() as f64)),
        settings,
        builtin: None,
    })
}

fn defaults() -> &'static Value {
    static DEFAULTS: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
        serde_json::to_value(&default_settings().session).expect("typed defaults serialize")
    });
    &DEFAULTS
}

fn merge_over(base: &Value, over: &Value) -> Value {
    if !over.is_object() {
        return base.clone();
    }
    let mut merged = base.as_object().cloned().unwrap_or_default();
    for (k, v) in over.as_object().cloned().unwrap_or_default() {
        merged.insert(k, v);
    }
    Value::Object(merged)
}

pub fn list_presets() -> Vec<Preset> {
    if let Some(cached) = CACHE.lock().expect("presets cache lock").clone() {
        return cached;
    }
    let file = get_presets_file();
    let parsed: Option<Value> = std::fs::read_to_string(&file).ok().and_then(|raw| serde_json::from_str(&raw).ok());
    let list: Vec<Preset> = match parsed {
        Some(v) => v
            .get("presets")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(normalise).collect())
            .unwrap_or_default(),
        None => {
            if file.exists() {
                let renamed = format!("{}.corrupt-{}", file.to_string_lossy(), now_millis());
                let _ = std::fs::rename(&file, &renamed);
                report_store_error("presets", "presets.json is unreadable and was set aside");
            }
            Vec::new()
        }
    };
    *CACHE.lock().expect("presets cache lock") = Some(list.clone());
    list
}

fn write_presets(presets: &[Preset]) -> Result<(), String> {
    let file = get_presets_file();
    if !ensure_dir(file.parent().unwrap_or(&data_dir())) {
        let err = "Data directory is not writable".to_string();
        report_store_error("presets", &err);
        return Err(err);
    }
    let tmp = file.with_extension("json.tmp");
    let payload = json!({ "version": FILE_VERSION, "presets": presets });
    let result = serde_json::to_string_pretty(&payload)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(&tmp, s).map_err(|e| e.to_string()))
        .and_then(|()| std::fs::rename(&tmp, &file).map_err(|e| e.to_string()));
    match result {
        Ok(()) => {
            *CACHE.lock().expect("presets cache lock") = Some(presets.to_vec());
            Ok(())
        }
        Err(err) => {
            report_store_error("presets", &err);
            Err(err)
        }
    }
}

/// Sort by name the way the renderer shows them. The TS list uses
/// `localeCompare(name, 'zh-Hans-CN')`; plain code-point order is the closest
/// dependency-free equivalent.
fn sort_presets(presets: &mut [Preset]) {
    presets.sort_by(|a, b| a.name.cmp(&b.name));
}

pub struct SavePresetInput {
    pub name: String,
    pub settings: SessionSettings,
}

/// Creates a preset, or overwrites the existing user preset with the same name.
pub fn save_preset(input: SavePresetInput) -> Result<Preset, String> {
    let language = crate::store::settings::get_language();
    let name: String = input.name.trim().chars().take(80).collect();
    if name.is_empty() {
        return Err(crate::shared::i18n::t(&language, "main.dialog.presetNameRequired"));
    }
    if builtin_presets().iter().any(|p| p.name.to_lowercase() == name.to_lowercase()) {
        return Err(crate::shared::i18n::t(&language, "main.dialog.presetNameBuiltin"));
    }

    let mut presets = list_presets();
    let index = presets.iter().position(|p| p.name.to_lowercase() == name.to_lowercase());
    // Normalise on the way in as well as out (see the TS original).
    let normalised = normalise(&json!({
        "id": index.map(|i| presets[i].id.clone()),
        "name": name,
        "savedAt": now_millis(),
        "settings": serde_json::to_value(&input.settings).unwrap_or(Value::Null),
    }))
    .ok_or_else(|| crate::shared::i18n::t(&language, "main.dialog.presetNameRequired"))?;
    let preset = normalised;
    match index {
        Some(i) => presets[i] = preset.clone(),
        None => presets.push(preset.clone()),
    }
    sort_presets(&mut presets);
    write_presets(&presets)?;
    Ok(preset)
}

pub fn delete_preset(id: &str) -> Result<Vec<Preset>, String> {
    let language = crate::store::settings::get_language();
    let presets = list_presets();
    if !presets.iter().any(|p| p.id == id) {
        return Err(crate::shared::i18n::t(&language, "main.dialog.presetNotFound"));
    }
    let remaining: Vec<Preset> = presets.into_iter().filter(|p| p.id != id).collect();
    write_presets(&remaining)?;
    Ok(remaining)
}

pub fn rename_preset(id: &str, name: &str) -> Result<Vec<Preset>, String> {
    let language = crate::store::settings::get_language();
    let trimmed: String = name.trim().chars().take(80).collect();
    if trimmed.is_empty() {
        return Err(crate::shared::i18n::t(&language, "main.dialog.presetNameRequired"));
    }
    if builtin_presets().iter().any(|p| p.name.to_lowercase() == trimmed.to_lowercase()) {
        return Err(crate::shared::i18n::t(&language, "main.dialog.presetNameBuiltin"));
    }
    let mut presets = list_presets();
    let target = presets.iter().find(|p| p.id == id);
    let Some(_) = target else {
        return Err(crate::shared::i18n::t(&language, "main.dialog.presetNotFound"));
    };
    if presets.iter().any(|p| p.id != id && p.name.to_lowercase() == trimmed.to_lowercase()) {
        return Err(crate::shared::i18n::t_params(
            &language,
            "main.dialog.presetNameTaken",
            &[("name", trimmed)],
        ));
    }
    for p in presets.iter_mut() {
        if p.id == id {
            p.name = trimmed.clone();
            p.saved_at = Some(now_millis() as f64);
        }
    }
    sort_presets(&mut presets);
    write_presets(&presets)?;
    Ok(presets)
}

/// Where the state files live, for display in the UI.
pub fn get_preset_location() -> PresetLocation {
    let dir = data_dir();
    PresetLocation {
        dir: dir.to_string_lossy().into_owned(),
        file: get_presets_file().to_string_lossy().into_owned(),
        app_root: app_root().to_string_lossy().into_owned(),
        writable: ensure_dir(&dir),
    }
}
