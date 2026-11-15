//! Port of `src/shared/defaults.ts`.
//!
//! The DEFAULT_SETTINGS / BUILTIN_PRESETS values are NOT hand-copied: they are
//! deserialized from `resources/i18n/defaults.json`, which
//! `scripts/generate-i18n.mjs` dumps from the TypeScript source of truth before
//! every build. A drift between the renderer's defaults and the backend's is
//! therefore impossible by construction (a cargo test additionally re-asserts
//! the file parses into the typed structs).

use crate::shared::types::{AppSettings, Preset};
use std::sync::LazyLock;

pub const BUFFER_SEC_MIN: f64 = 12.0;
pub const BUFFER_SEC_MAX: f64 = 300.0;
/// Lead applied when the buffered playout is switched on from a smaller value.
pub const BUFFER_SEC_DEFAULT: f64 = BUFFER_SEC_MIN;

/// Bounds enforced by the UI and the control server.
pub const OBS_PORT_MIN: f64 = 1024.0;
pub const OBS_PORT_MAX: f64 = 65535.0;

/// How many log entries the run keeps in memory. Shared by the backend (the
/// app-side ring buffer) and the renderer (its copy of the history).
pub const LOG_HISTORY_LIMIT: usize = 5000;

pub const CONTAINER_MUXER: [(&str, &str); 3] = [("flv", "flv"), ("mpegts", "mpegts"), ("mkv", "matroska")];

pub fn container_muxer(container: &str) -> &'static str {
    CONTAINER_MUXER
        .iter()
        .find(|(name, _)| *name == container)
        .map(|(_, muxer)| *muxer)
        .unwrap_or("flv")
}

static DEFAULTS: LazyLock<DefaultsFile> = LazyLock::new(|| {
    let raw = include_str!("../../resources/i18n/defaults.json");
    serde_json::from_str(raw).expect("generated defaults.json must parse")
});

#[derive(serde::Deserialize)]
struct DefaultsFile {
    #[serde(rename = "DEFAULT_SETTINGS")]
    default_settings: AppSettings,
    #[serde(rename = "BUILTIN_PRESETS")]
    builtin_presets: Vec<Preset>,
}

pub fn default_settings() -> &'static AppSettings {
    &DEFAULTS.default_settings
}

pub fn builtin_presets() -> &'static [Preset] {
    &DEFAULTS.builtin_presets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_defaults_parse_into_typed_settings() {
        let s = default_settings();
        assert_eq!(s.session.output.buffer_sec, BUFFER_SEC_DEFAULT);
        assert_eq!(s.session.output.obs_web_socket.port, 4455.0);
        assert_eq!(s.language, "en");
        assert!(!s.language_set);
        assert_eq!(s.theme, "system");
        assert!((s.playlist_width_percent - 27.0).abs() < f64::EPSILON);
        assert_eq!(s.session.video.bitrate_kbps, 6000.0);
        assert_eq!(s.session.audio.sample_rate, 44100.0);
        assert_eq!(builtin_presets().len(), 5);
    }
}
