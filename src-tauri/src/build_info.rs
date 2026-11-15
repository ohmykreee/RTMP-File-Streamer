//! Build identity, written by `scripts/build-info.mjs` at build time into
//! `build-info.json` next to `package.json` and embedded into the binary at
//! compile time. Port of `src/main/buildInfo.ts`.
//!
//! The Electron backend still reads the file next to the executable at runtime;
//! the Tauri backend compiles it in (`include_str!` tracks the file, so a
//! rebuilt `build-info.json` recompiles the crate), which is why the portable
//! dist needs nothing but the executable. The file IS required: it is written
//! before every compile (`pnpm dev:tauri` / `pnpm build:tauri` / CI), and a
//! missing file fails at compile time like the generated i18n JSON does.

use serde::Deserialize;

/// The build identity, generated before the Rust compile. Missing means
/// `build-info.mjs` was skipped — regenerate it and build again.
const BUILD_INFO_JSON: &str = include_str!("../../build-info.json");

#[derive(Debug, Clone, Deserialize)]
pub struct BuildInfo {
    pub version: String,
    pub commit: String,
    pub nightly: bool,
    pub built_at: String,
}

pub fn read_build_info() -> Option<BuildInfo> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        version: String,
        #[serde(default)]
        commit: String,
        #[serde(default = "default_nightly")]
        nightly: bool,
        #[serde(default)]
        built_at: String,
    }
    fn default_nightly() -> bool {
        true
    }
    let parsed: Raw = match serde_json::from_str(BUILD_INFO_JSON) {
        Ok(parsed) => parsed,
        Err(_) => return None,
    };
    if parsed.version.is_empty() {
        return None;
    }
    Some(BuildInfo {
        version: parsed.version,
        commit: parsed.commit,
        nightly: parsed.nightly,
        built_at: parsed.built_at,
    })
}
