//! Build identity, written by `scripts/build-info.mjs` at build time into
//! `build-info.json` next to `package.json`. Port of `src/main/buildInfo.ts`.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct BuildInfo {
    pub version: String,
    pub commit: String,
    pub nightly: bool,
    pub built_at: String,
}

pub fn read_build_info() -> Option<BuildInfo> {
    let path = crate::store::paths::app_root().join("build-info.json");
    let raw = std::fs::read_to_string(path).ok()?;
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
    let parsed: Raw = serde_json::from_str(&raw).ok()?;
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
