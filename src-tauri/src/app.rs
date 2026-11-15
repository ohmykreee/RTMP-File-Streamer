//! Application state, bootstrap and shutdown. Port of the service wiring in
//! `src/main/index.ts` onto the Tauri shell.

use crate::ffmpeg::capabilities::{resolve_binaries};
use crate::obs::websocket::{ObsWebSocketDeps, ObsWebSocketServer};
use crate::shared::defaults::{builtin_presets, LOG_HISTORY_LIMIT};
use crate::shared::i18n;
use crate::shared::protocol::detect_stream_protocol;
use crate::shared::types::{ipc_channels, EngineStatus, LogEntry};
use crate::store::logger::{append_log_entry, close_log_session, flush_now, get_persisted_log_info, start_log_session};
use crate::store::paths::{cache_dir, setup_data_paths};
use crate::store::playlist::{
    get_cached_media, load_persisted_playlist, persist_playlist, probe_cached,
};
use crate::store::presets::list_presets;
use crate::store::settings::{get_language, get_settings_path, load_settings, save_settings};
use crate::stream::byte_rate::now_ms;
use crate::stream::engine::{EngineDeps, EngineSink, StreamEngine};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use crate::shared::types::PlaylistItem;
use tauri::{AppHandle, Emitter, Manager};

/// The central application state shared by the Tauri commands.
pub struct App {
    pub engine: OnceLock<Arc<StreamEngine>>,
    pub obs: OnceLock<Arc<ObsWebSocketServer>>,
    pub logs: Mutex<Vec<LogEntry>>,
    pub playlist: Mutex<Vec<PlaylistItem>>,
    log_seq: AtomicU64,
    persist_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// Guards the quit sequence so it runs exactly once.
    pub shutting_down: AtomicBool,
}

impl App {
    pub fn new() -> Self {
        Self {
            engine: OnceLock::new(),
            obs: OnceLock::new(),
            logs: Mutex::new(Vec::new()),
            playlist: Mutex::new(Vec::new()),
            log_seq: AtomicU64::new(1),
            persist_task: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn engine(&self) -> Arc<StreamEngine> {
        self.engine.get().expect("engine initialized").clone()
    }

    pub fn obs(&self) -> Arc<ObsWebSocketServer> {
        self.obs.get().expect("obs initialized").clone()
    }

    /// The app-level `emitLog`: debug gating, redaction at the single sink,
    /// ring buffer, event push and the persisted JSONL file.
    pub fn emit_log(&self, entry: LogEntry, context: Option<(String, String)>) {
        // Debug detail is opt-in; `info` and above are never filtered, so the
        // moment the switch is turned off is itself in the log.
        if entry.level == "debug" && !load_settings().debug_logging {
            return;
        }
        // Every producer (command lines, ffmpeg banners, the connection test)
        // can print the push target: redact at this single sink so the
        // persisted file, the panel and any copy made from it are safe without
        // each producer having to remember.
        let secrets = crate::log_redact::collect_secrets(Some(&load_settings().session.output));
        let safe = LogEntry {
            id: entry.id,
            ts: entry.ts,
            level: entry.level.clone(),
            message: crate::log_redact::redact_text(&entry.message, &secrets),
        };
        {
            let mut logs = self.logs.lock().expect("app logs lock");
            logs.push(safe.clone());
            if logs.len() > LOG_HISTORY_LIMIT {
                let excess = logs.len() - LOG_HISTORY_LIMIT;
                logs.drain(..excess);
            }
        }
        if let Some(app) = TAURI_HANDLE.get() {
            let _ = app.emit(ipc_channels::EVT_LOG, &safe);
        }
        let ctx: Option<(&str, &str)> = context.as_ref().map(|(item, file)| (item.as_str(), file.as_str()));
        append_log_entry(&safe, ctx);
    }

    pub fn push_log(&self, level: &str, message: String) {
        let id = self.log_seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.emit_log(LogEntry { id, ts: now_ms(), level: level.into(), message }, None);
    }

    /// 700 ms debounced persist of the queue, like `schedulePersist`.
    pub fn schedule_persist(&self, items: Vec<PlaylistItem>) {
        *self.playlist.lock().expect("app playlist lock") = items.clone();
        let mut task = self.persist_task.lock().expect("persist task lock");
        if let Some(old) = task.take() {
            old.abort();
        }
        // tauri::async_runtime instead of tokio::spawn: this runs during
        // bootstrap on the main thread, outside any runtime context, too.
        let handle = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            persist_playlist(&items);
        });
        *task = Some(handle);
    }

    pub fn playlist_now(&self) -> Vec<PlaylistItem> {
        self.playlist.lock().expect("app playlist lock").clone()
    }
}

/// mainT equivalent for the app layer: translated at call time from the
/// settings store, so a language switch applies to the next line.
pub fn main_t(key: &str) -> String {
    i18n::t(&get_language(), key)
}

pub fn main_t_params(key: &str, params: Vec<(&'static str, String)>) -> String {
    i18n::t_params(&get_language(), key, &params)
}

pub static APP: OnceLock<Arc<App>> = OnceLock::new();
pub static TAURI_HANDLE: OnceLock<AppHandle> = OnceLock::new();

fn app_state() -> &'static Arc<App> {
    APP.get().expect("app state initialized")
}

/// Wires the engine, the obs-websocket server and their sinks to the app state
/// and the Tauri event emitter. Called once from `bootstrap`.
fn bootstrap_services(handle: &AppHandle) {
    let state = app_state();
    let _ = handle;

    /* ---------------- engine ---------------- */
    let engine_app = Arc::downgrade(state);
    let deps = EngineDeps {
        get_ffmpeg_path: Arc::new(|| {
            let s = load_settings();
            resolve_binaries(&s.ffmpeg_path, &s.ffprobe_path).ffmpeg
        }),
        get_settings: Arc::new(|| load_settings().session),
        get_media: Arc::new(|path| get_cached_media(path)),
        probe_media: Arc::new(|path| {
            Box::pin(async move {
                let s = load_settings();
                let resolved = resolve_binaries(&s.ffmpeg_path, &s.ffprobe_path);
                probe_cached(&resolved.ffprobe, &path, Some(&s.language)).await
            })
        }),
        get_language: Arc::new(get_language),
    };
    let sink_log_app = engine_app.clone();
    let sink_playlist_app = engine_app.clone();
    let sink = EngineSink {
        status: Arc::new(|status: EngineStatus| {
            if let Some(app) = TAURI_HANDLE.get() {
                let _ = app.emit(ipc_channels::EVT_STATUS, &status);
            }
        }),
        log: Arc::new(move |entry: LogEntry| {
            let Some(app) = sink_log_app.upgrade() else { return };
            // The engine tags entries with the file they belong to, so a later
            // reader can tell which item a warning or failure came from.
            let idx = app.engine().get_status().current_index;
            let current = if idx >= 0 {
                app.playlist_now().get(idx as usize).cloned()
            } else {
                None
            };
            app.emit_log(entry, current.map(|i| (i.name, i.path)));
        }),
        playlist: Arc::new(move |items: Vec<PlaylistItem>| {
            if let Some(app) = sink_playlist_app.upgrade() {
                app.schedule_persist(items.clone());
            }
            if let Some(handle) = TAURI_HANDLE.get() {
                let _ = handle.emit(ipc_channels::EVT_PLAYLIST, &items);
            }
        }),
    };
    let engine = StreamEngine::new(deps, sink);
    let _ = state.engine.set(engine.clone());

    /* ---------------- obs-websocket control server ---------------- */
    let obs_app = Arc::downgrade(state);
    let obs_log_app = Arc::downgrade(state);
    let obs_deps = ObsWebSocketDeps {
        settings: Arc::new(|| load_settings().session.output.obs_web_socket),
        stream_target: Arc::new(|| {
            let out = &load_settings().session.output;
            (out.server.clone(), out.stream_key.clone())
        }),
        apply_stream_target: Arc::new(move |server, stream_key| {
            let current = load_settings();
            let mut output = current.session.output.clone();
            if let Some(server) = &server {
                output.server = server.clone();
            }
            if let Some(key) = &stream_key {
                output.stream_key = key.clone();
            }
            if let Some(server) = &server {
                if server.trim().is_empty() {
                    return Err(main_t("main.dialog.emptyServer"));
                }
                // The protocol is derived from the address everywhere else; a
                // remote client writing `srt://…` into a session still marked
                // rtmp would otherwise reach ffmpeg as `-f flv srt://…`.
                let protocol = detect_stream_protocol(server);
                output.network =
                    crate::shared::protocol::network_for_protocol(Some(&protocol), Some(&output.network));
                output.protocol = protocol;
            }
            // One write, not two (see the TS original for the double-broadcast bug).
            let next = save_settings(serde_json::json!({ "session": { "output": output } }));
            if let Some(handle) = TAURI_HANDLE.get() {
                let _ = handle.emit(ipc_channels::EVT_SETTINGS, &next);
            }
            if let Some(app) = obs_app.upgrade() {
                app.push_log(
                    "debug",
                    format!("obs stream target updated: {} key {}", server.is_some(), stream_key.is_some()),
                );
            }
            Ok(())
        }),
        engine_state: Arc::new({
            let engine = engine.clone();
            move || engine.get_status().state
        }),
        start_stream: Arc::new({
            let engine = engine.clone();
            move || {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let engine = engine.clone();
                tokio::spawn(async move {
                    engine.start(None).await;
                    let _ = tx.send(());
                });
                rx
            }
        }),
        stop_stream: Arc::new({
            let engine = engine.clone();
            move || {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let engine = engine.clone();
                tokio::spawn(async move {
                    engine.stop().await;
                    let _ = tx.send(());
                });
                rx
            }
        }),
        log: Arc::new(move |level, message| {
            if let Some(app) = obs_log_app.upgrade() {
                app.push_log(level, message);
            }
        }),
        t: Arc::new(|key, params| main_t_params(key, params)),
    };
    let obs = ObsWebSocketServer::new(obs_deps);
    let _ = state.obs.set(obs);

    /* ---------------- store write failures → log ---------------- */
    let err_app = Arc::downgrade(state);
    crate::store::errors::set_store_error_handler(move |area, error| {
        if let Some(app) = err_app.upgrade() {
            app.push_log(
                "error",
                main_t_params("main.store.writeFailed", vec![("area", area.into()), ("error", error.into())]),
            );
        }
    });
}

/// The full bootstrap, mirroring `app.whenReady()` in `src/main/index.ts`.
pub fn bootstrap(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Redirect the webview's writable paths into `Data/` before anything reads
    // them (the portable-folder contract).
    setup_data_paths();
    let handle = app.handle().clone();
    let _ = TAURI_HANDLE.set(handle.clone());

    let state = Arc::new(App::new());
    app.manage(state.clone());
    let _ = APP.set(state.clone());

    // Start persisting logs before anything can go wrong.
    start_log_session(&main_t_params("main.engine.appStarted", vec![("pid", std::process::id().to_string())]));

    // Resolve the interface language before the window exists (loadSettings
    // detects it; the log records which language a first launch landed on).
    let initial = load_settings();
    state.push_log(
        "info",
        if initial.language_set {
            main_t_params("main.engine.languageSaved", vec![("language", initial.language.clone())])
        } else {
            main_t_params("main.engine.languageDetected", vec![("language", initial.language.clone())])
        },
    );

    // Report translation drift once per launch: a missing translation renders
    // the reference language in one spot, which reads as a styling accident.
    for problem in i18n::catalog_problems() {
        state.push_log("warn", format!("[i18n] {problem}"));
    }

    bootstrap_services(&handle);

    // Bring the control endpoint up if it was left enabled; errors are
    // reported through the log and surfaced in the settings tab.
    {
        let obs = state.obs();
        tauri::async_runtime::spawn(async move {
            let _ = obs.apply().await;
        });
    }

    // Restore the queue and re-validate each entry in the background.
    let persisted = load_persisted_playlist();
    if !persisted.is_empty() {
        *state.playlist.lock().expect("playlist lock") = persisted.clone();
        state.engine().set_playlist(persisted.clone());
        let _ = handle.emit(ipc_channels::EVT_PLAYLIST, &persisted);
        state.push_log("info", main_t_params("main.engine.restoredPlaylist", vec![("n", persisted.len().to_string())]));
        let engine = state.engine();
        tauri::async_runtime::spawn(async move {
            // Refresh durations in the background; files may have moved or
            // changed since the last session.
            let s = load_settings();
            let resolved = resolve_binaries(&s.ffmpeg_path, &s.ffprobe_path);
            let mut refreshed = persisted.clone();
            let mut changed = false;
            for item in refreshed.iter_mut() {
                let info = probe_cached(&resolved.ffprobe, &item.path, Some(&s.language)).await;
                if info.probe_error.is_some() && info.streams.is_empty() {
                    item.broken = Some(true);
                    item.status = "pending".into();
                    let name = item.name.clone();
                    APP.get().expect("app").push_log(
                        "warn",
                        main_t_params(
                            "main.engine.itemInaccessible",
                            vec![("name", name), ("message", info.probe_error.clone().unwrap_or_default())],
                        ),
                    );
                    changed = true;
                    continue;
                }
                // The file is readable again: clear a stale "unreadable" badge.
                if item.broken == Some(true) {
                    item.broken = None;
                    item.error = None;
                    changed = true;
                }
                if info.duration_sec != 0.0 && (info.duration_sec - item.duration_sec).abs() > 0.5 {
                    item.duration_sec = info.duration_sec;
                    changed = true;
                }
                if item.subtitle_tracks.is_empty() && !info.subtitle_streams.is_empty() {
                    item.subtitle_tracks = crate::ffmpeg::probe::embedded_subtitle_refs(&info);
                    if item.selected_subtitle_id.is_none() {
                        item.selected_subtitle_id = item.subtitle_tracks.first().map(|t| t.id.clone());
                    }
                    changed = true;
                }
            }
            if changed {
                engine.set_playlist(refreshed);
            }
        });
    }

    // ffmpeg resolution logging.
    let s = load_settings();
    let resolved = resolve_binaries(&s.ffmpeg_path, &s.ffprobe_path);
    if !resolved.ffmpeg.is_empty() {
        state.push_log(
            "info",
            main_t_params("main.engine.ffmpegResolved", vec![("path", resolved.ffmpeg.clone()), ("source", resolved.source.clone())]),
        );
        if !resolved.ffprobe.is_empty() {
            state.push_log("debug", format!("ffprobe: {}", resolved.ffprobe));
        } else {
            state.push_log("warn", main_t("main.engine.ffprobeMissing"));
        }
    } else {
        state.push_log("error", main_t("main.engine.ffmpegMissing"));
    }
    state.push_log("debug", main_t_params("main.engine.configFile", vec![("path", get_settings_path())]));
    {
        let loc = crate::store::presets::get_preset_location();
        let mut message = main_t_params("main.engine.dataDir", vec![("dir", loc.dir.clone())]);
        if !loc.writable {
            message.push_str(&main_t("main.engine.dataDirReadOnly"));
        }
        state.push_log("info", message);
        state.push_log("debug", main_t_params("main.engine.cacheDir", vec![("dir", cache_dir().to_string_lossy().into_owned())]));
        let log_info = get_persisted_log_info();
        state.push_log(
            "info",
            main_t_params(
                "main.engine.logRetention",
                vec![
                    (
                        "file",
                        if log_info.current_file.is_empty() {
                            main_t("main.engine.logRetentionOff")
                        } else {
                            log_info.current_file.clone()
                        },
                    ),
                    ("files", log_info.file_count.to_string()),
                    ("kb", format!("{:.0}", log_info.total_bytes as f64 / 1024.0)),
                    ("mb", format!("{:.0}", log_info.budget_bytes as f64 / 1024.0 / 1024.0)),
                ],
            ),
        );
        let user_count = list_presets().len();
        state.push_log(
            "debug",
            main_t_params("main.engine.presetsLoaded", vec![("user", user_count.to_string()), ("builtin", builtin_presets().len().to_string())]),
        );
    }

    Ok(())
}

/// The window's background for the appearance in force (used before the window
/// exists; the exact system theme is applied right after creation, while the
/// window is still hidden).
pub fn window_background() -> (u8, u8, u8) {
    let dark = load_settings().theme == "dark";
    if dark {
        (0x09, 0x09, 0x0b)
    } else {
        (0xff, 0xff, 0xff)
    }
}

/// The quit sequence (`before-quit` + `window-all-closed` in the TS original):
/// persist the queue, stop the engine (killing the ffmpeg children), stop the
/// control endpoint, close the log session — then exit.
pub async fn shutdown(app: &AppHandle) {
    let Some(state) = APP.get() else {
        app.exit(0);
        return;
    };
    if state.shutting_down.swap(true, Ordering::SeqCst) {
        return;
    }
    persist_playlist(&state.playlist_now());
    state.push_log("info", main_t("main.engine.exiting"));
    let _ = state.engine().stop().await;
    state.obs().stop().await;
    flush_now();
    close_log_session();
    app.exit(0);
}


