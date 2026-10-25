//! All application state lives in a `Data` folder inside the unpacked
//! application directory, so the whole folder stays self-contained and portable
//! — nothing is written to the user profile. Port of `src/main/store/paths.ts`.
//!
//! Layout:
//!   Data/settings.json   ffmpeg paths + current session settings
//!   Data/playlist.json   the queue, restored on next launch
//!   Data/presets.json    user-saved presets
//!   Data/Logs/           persisted run logs (rotated, size-capped)
//!   Data/Cache/          webview caches (kept out of the main folder)

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub fn app_root() -> PathBuf {
    // Development: the project root (cargo run from src-tauri would nest deeper,
    // so walk up to the folder holding package.json).
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut dir: Option<&Path> = Some(cwd.as_path());
    while let Some(d) = dir {
        if d.join("package.json").is_file() && d.join("src-tauri").is_dir() {
            return d.to_path_buf();
        }
        dir = d.parent();
    }
    // Packaged: the folder holding the executable (a portable install keeps its
    // Data/ next to the exe).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.to_path_buf();
        }
    }
    cwd
}

pub fn data_dir() -> PathBuf {
    app_root().join("Data")
}

pub fn cache_dir() -> PathBuf {
    data_dir().join("Cache")
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("Logs")
}

/// The resources dir shipped next to the executable (packaged layout). None in
/// a pure dev run, where the app root's own folders are used instead.
pub fn resources_dir() -> Option<String> {
    // Tauri sets this for packaged builds.
    Some(app_root().join("resources").to_string_lossy().into_owned())
}

pub fn ensure_dir(dir: &Path) -> bool {
    match std::fs::create_dir_all(dir) {
        Ok(()) => writable(dir),
        Err(_) => false,
    }
}

fn writable(dir: &Path) -> bool {
    // Probe with an actual write: metadata permissions are unreliable on Windows.
    let probe = dir.join(".write-probe");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub struct PathSetup {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub writable: bool,
}

static SETUP: OnceLock<PathSetup> = OnceLock::new();

/// Creates the Data folder tree on first run. Must be called before anything
/// reads `data_dir()`.
pub fn setup_data_paths() -> &'static PathSetup {
    SETUP.get_or_init(|| {
        let data = data_dir();
        let cache = cache_dir();
        let writable = ensure_dir(&data);
        ensure_dir(&cache);
        // The webview's own user-data folder (Chromium profile storage) follows
        // the same portable contract: it lives under Data/Cache, never in the
        // user profile. The Tauri shell reads this path for its data_directory.
        PathSetup { data_dir: data, cache_dir: cache, writable }
    })
}

pub fn get_path_setup() -> &'static PathSetup {
    setup_data_paths()
}

/// `path.resolve` equivalent for the paths handled here: makes a relative path
/// absolute against the process working directory.
pub fn resolve_path(p: &str) -> String {
    let path = Path::new(p);
    if path.is_absolute() {
        normalize_path(path)
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        normalize_path(&cwd.join(path))
    }
}

/// Lexical normalisation: collapses `.` and `..` without touching the file
/// system (the JS `path.resolve` behaves the same for existing paths).
fn normalize_path(path: &Path) -> String {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}
