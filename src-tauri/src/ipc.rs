//! The renderer-facing command surface. Port of `src/main/ipc.ts`; every
//! command keeps the behaviour (and error strings) of the `ipcMain.handle`
//! original. The channel-name map disappears — Tauri commands are named.

use crate::app::{main_t, main_t_params, App, TAURI_HANDLE};
use crate::ffmpeg::capabilities::{
    get_capabilities, resolve_binaries, run_process, set_available_encoder_names, ENCODER_CATALOGUE,
};
use crate::ffmpeg::command::{build_command_line, build_test_command};
use crate::ffmpeg::probe::embedded_subtitle_refs;
use crate::log_redact::{collect_secrets, mask_target, redact_text};
use crate::shared::defaults::{builtin_presets, BUFFER_SEC_DEFAULT, BUFFER_SEC_MAX, BUFFER_SEC_MIN, OBS_PORT_MAX, OBS_PORT_MIN};
use crate::shared::protocol::{address_matches_protocol, detect_stream_protocol, protocol_schemes};
use crate::shared::types::{
    base_name, ext_name, AppInfo, AppSettings, EngineStatus, FfmpegCapabilities, LogEntry,
    ObsWebSocketStatus, PersistedLogInfo, PlaylistItem, PresetsPayload, ProbeResult,
    RtmpTestRequest, RtmpTestResult, SessionSettings, SUPPORTED_SUBTITLE_EXT, SUPPORTED_VIDEO_EXT,
    THEME_PREFERENCES,
};
use crate::store::logger::get_persisted_log_info;
use crate::stream::byte_rate::now_ms;
use crate::store::paths::data_dir;
use crate::store::playlist::{
    attach_subtitle_file, create_playlist_items, probe_cached, reorder_by_id,
};
use crate::store::presets::{
    delete_preset, get_preset_location, list_presets, rename_preset, save_preset, SavePresetInput,
};
use crate::store::settings::{
    get_language, load_settings, save_settings as persist_settings,
    set_language as persist_language,
};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type CmdResult<T> = Result<T, String>;

fn app_state() -> &'static Arc<App> {
    crate::app::APP.get().expect("app state")
}

fn handle() -> AppHandle {
    TAURI_HANDLE.get().expect("app handle").clone()
}

/* ------------------------------------------------------------------ *
 * app / settings
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn get_app_info() -> CmdResult<AppInfo> {
    let build = crate::build_info::read_build_info();
    Ok(AppInfo {
        version: build
            .as_ref()
            .map(|b| b.version.clone())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        commit: build.as_ref().map(|b| b.commit.clone()).filter(|c| !c.is_empty()),
        nightly: build.as_ref().map(|b| b.nightly),
        built_at: build.as_ref().map(|b| b.built_at.clone()).filter(|b| !b.is_empty()),
        electron: format!("tauri {}", tauri::VERSION),
        chrome: match std::env::consts::OS {
            "windows" => "WebView2",
            "macos" => "WKWebView",
            _ => "WebKitGTK",
        }
        .to_string(),
        node: String::new(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        user_data_path: data_dir().to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn get_settings() -> CmdResult<AppSettings> {
    Ok(load_settings())
}

/// Every save (preset apply, obs-websocket's own write, a settings tab) goes
/// through here. Comparing the blocks keeps the obs listener in step without
/// restarting it on unrelated saves, and the window is repainted in the
/// palette the theme setting asks for.
#[tauri::command]
pub fn save_settings(patch: serde_json::Value) -> CmdResult<AppSettings> {
    let state = app_state();
    let before = load_settings();
    let next = persist_settings(patch);
    if before.debug_logging != next.debug_logging {
        state.push_log(
            "info",
            if next.debug_logging {
                main_t("main.engine.debugOn")
            } else {
                main_t("main.engine.debugOff")
            },
        );
    }
    if before.theme != next.theme {
        crate::window::sync_window_theme(&handle());
    }
    if serde_json::to_string(&before.session.output.obs_web_socket).unwrap_or_default()
        != serde_json::to_string(&next.session.output.obs_web_socket).unwrap_or_default()
    {
        let obs = state.obs();
        tauri::async_runtime::spawn(async move {
            let _ = obs.apply().await;
        });
    }
    Ok(next)
}

/// Switches the interface language. Its own command rather than a
/// `saveSettings` patch: it records the choice as deliberate and re-broadcasts
/// the settings so the renderer ends up with the persisted value (including
/// `languageSet`).
#[tauri::command]
pub fn set_language(language: String) -> CmdResult<AppSettings> {
    let next = persist_language(&language);
    let _ = handle().emit(crate::shared::types::ipc_channels::EVT_SETTINGS, &next);
    Ok(next)
}

/* ------------------------------------------------------------------ *
 * ffmpeg discovery / capabilities
 * ------------------------------------------------------------------ */

#[tauri::command]
pub async fn get_app_capabilities(force: bool) -> CmdResult<FfmpegCapabilities> {
    let settings = load_settings();
    let resolved = resolve_binaries(&settings.ffmpeg_path, &settings.ffprobe_path);
    let caps = get_capabilities(&resolved.ffmpeg, &resolved.ffprobe, &resolved.source, force, &settings.language).await;
    let names: HashSet<String> = caps
        .encoders
        .iter()
        .filter(|e| e.available)
        .filter_map(|e| ENCODER_CATALOGUE.iter().find(|d| d.value == e.value).map(|d| d.ffmpeg_name.to_string()))
        .collect();
    let names = if names.is_empty() {
        HashSet::from(["libx264".to_string()])
    } else {
        names
    };
    set_available_encoder_names(names);
    Ok(caps)
}

#[tauri::command]
pub async fn pick_ffmpeg() -> CmdResult<Option<String>> {
    let app = handle();
    let dialog = app.dialog().file();
    let dialog = if cfg!(windows) {
        dialog.add_filter(main_t("main.dialog.executables"), &["exe"])
    } else {
        dialog.add_filter(main_t("main.dialog.allFiles"), &["*"])
    };
    let picked = dialog.blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let chosen = picked.into_path().map_err(|e| e.to_string())?;
    let chosen_str = chosen.to_string_lossy().into_owned();
    let sibling = chosen
        .parent()
        .map(|d| d.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" }))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut patch = serde_json::json!({ "ffmpegPath": chosen_str });
    if std::path::Path::new(&sibling).exists() {
        patch["ffprobePath"] = serde_json::json!(sibling);
    }
    save_settings(patch)?;
    app_state().push_log("info", main_t_params("main.caps.ffmpegUpdated", vec![("path", chosen_str.clone())]));
    Ok(Some(chosen_str))
}

fn media_filter(exts: &[&str], label: String) -> (&'static str, Vec<&'static str>) {
    // Filters need 'static strings; the translated label and the extension list
    // live for the dialog's lifetime via leak, matching the handful of dialog
    // calls per session.
    let leaked: &'static str = Box::leak(label.into_boxed_str());
    let exts: &'static [&'static str] =
        Box::leak(exts.iter().map(|e| Box::leak(e.trim_start_matches('.').to_string().into_boxed_str()) as &'static str).collect::<Vec<_>>().into_boxed_slice());
    (leaked, exts.to_vec())
}

#[tauri::command]
pub async fn pick_video_files() -> CmdResult<Vec<String>> {
    let app = handle();
    let (name, exts) = media_filter(&SUPPORTED_VIDEO_EXT, main_t("main.dialog.videoFiles"));
    let picked = app
        .dialog()
        .file()
        .add_filter(name, &exts)
        .add_filter(Box::leak(main_t("main.dialog.allFiles").into_boxed_str()), &["*"])
        .blocking_pick_files();
    Ok(paths_from(picked))
}

#[tauri::command]
pub async fn pick_subtitle_files() -> CmdResult<Vec<String>> {
    let app = handle();
    let (name, exts) = media_filter(&SUPPORTED_SUBTITLE_EXT, main_t("main.dialog.subtitleFiles"));
    let picked = app
        .dialog()
        .file()
        .add_filter(name, &exts)
        .add_filter(Box::leak(main_t("main.dialog.allFiles").into_boxed_str()), &["*"])
        .blocking_pick_files();
    Ok(paths_from(picked))
}

fn paths_from(picked: Option<Vec<tauri_plugin_dialog::FilePath>>) -> Vec<String> {
    picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/* ------------------------------------------------------------------ *
 * probing
 * ------------------------------------------------------------------ */

#[tauri::command]
pub async fn probe(path: String) -> CmdResult<ProbeResult> {
    let settings = load_settings();
    let resolved = resolve_binaries(&settings.ffmpeg_path, &settings.ffprobe_path);
    let info = probe_cached(&resolved.ffprobe, &path, Some(&settings.language)).await;
    Ok(ProbeResult { subtitles: embedded_subtitle_refs(&info), info })
}

/* ------------------------------------------------------------------ *
 * playlist
 * ------------------------------------------------------------------ */

/// The engine's bookkeeping is index-based, and the renderer freezes edits
/// while a session runs. The command surface is reachable from other callers,
/// so the same rule is enforced here rather than relying on the UI.
fn ensure_playlist_mutable(state: &App) -> CmdResult<()> {
    let status = state.engine().get_status();
    if status.state == "idle" || status.state == "error" {
        Ok(())
    } else {
        Err(main_t("main.engine.playlistLocked"))
    }
}

#[tauri::command]
pub fn playlist_get() -> CmdResult<Vec<PlaylistItem>> {
    Ok(app_state().playlist_now())
}

#[tauri::command]
pub async fn playlist_add(paths: Vec<String>) -> CmdResult<Vec<PlaylistItem>> {
    let state = app_state();
    ensure_playlist_mutable(state)?;
    // Only video files belong in the playlist; a stray subtitle that slipped
    // into a drop would otherwise be probed as a "video" and fail to stream.
    let total = paths.len();
    let videos: Vec<String> = paths
        .into_iter()
        .filter(|p| SUPPORTED_VIDEO_EXT.contains(&ext_name(p).as_str()))
        .collect();
    // The renderer surfaces this line so a dropped subtitle that quietly
    // vanished is not a mystery (the Electron IPC handler logged the same).
    let skipped = total - videos.len();
    if skipped > 0 {
        state.push_log(
            "info",
            main_t_params("main.engine.ignoredNonVideo", vec![("n", skipped.to_string())]),
        );
    }
    let s = load_settings();
    let resolved = resolve_binaries(&s.ffmpeg_path, &s.ffprobe_path);
    state.push_log("info", main_t_params("main.engine.parsingFiles", vec![("n", videos.len().to_string())]));
    let result = create_playlist_items(&resolved.ffprobe, &videos, (s.session.subtitles.mode.clone(), Some(s.language.clone()))).await;
    for (path, message) in &result.errors {
        state.push_log(
            "error",
            main_t_params("main.engine.unreadableFile", vec![("name", base_name(path)), ("message", message.clone())]),
        );
    }
    let items = result.items;
    if !items.is_empty() {
        let mut playlist = state.playlist_now();
        playlist.extend(items.clone());
        state.engine().set_playlist(playlist);
        let with_subs = items.iter().filter(|i| !i.subtitle_tracks.is_empty()).count();
        let extra = if with_subs > 0 {
            main_t_params("main.engine.addedFilesSubs", vec![("n", with_subs.to_string())])
        } else {
            String::new()
        };
        state.push_log("info", main_t_params("main.engine.addedFiles", vec![("n", items.len().to_string()), ("extra", extra)]));
    }
    Ok(items)
}

#[tauri::command]
pub async fn playlist_attach_subtitle(item_id: String, file_path: String) -> CmdResult<Option<PlaylistItem>> {
    let state = app_state();
    ensure_playlist_mutable(state)?;
    let s = load_settings();
    let resolved = resolve_binaries(&s.ffmpeg_path, &s.ffprobe_path);
    let mut playlist = state.playlist_now();
    let Some(item) = playlist.iter_mut().find(|i| i.id == item_id) else {
        return Ok(None);
    };
    let reference = attach_subtitle_file(&resolved.ffprobe, item, &file_path, Some(&s.language)).await;
    let Some(reference) = reference else {
        state.push_log("error", main_t_params("main.engine.subtitleUnreadable", vec![("name", base_name(&file_path))]));
        return Ok(None);
    };
    if !item.subtitle_tracks.iter().any(|t| t.id == reference.id) {
        item.subtitle_tracks.push(reference.clone());
    }
    item.selected_subtitle_id = Some(reference.id);
    if item.mode == "off" {
        item.mode = if s.session.subtitles.mode == "off" { "burn".into() } else { s.session.subtitles.mode.clone() };
    }
    let item = item.clone();
    state.engine().set_playlist(playlist);
    state.push_log(
        "info",
        main_t_params(
            "main.engine.subtitleAttached",
            vec![("name", item.name.clone()), ("file", base_name(&file_path))],
        ),
    );
    Ok(Some(item))
}

#[tauri::command]
pub fn playlist_remove(item_id: String) -> CmdResult<()> {
    let state = app_state();
    ensure_playlist_mutable(state)?;
    let mut playlist = state.playlist_now();
    playlist.retain(|i| i.id != item_id);
    state.engine().set_playlist(playlist);
    Ok(())
}

#[tauri::command]
pub fn playlist_clear() -> CmdResult<()> {
    let state = app_state();
    ensure_playlist_mutable(state)?;
    state.engine().set_playlist(vec![]);
    Ok(())
}

#[tauri::command]
pub fn playlist_reorder(ordered_ids: Vec<String>) -> CmdResult<()> {
    let state = app_state();
    ensure_playlist_mutable(state)?;
    let playlist = reorder_by_id(&state.playlist_now(), &ordered_ids);
    state.engine().set_playlist(playlist);
    Ok(())
}

#[tauri::command]
pub fn playlist_update_item(item_id: String, patch: serde_json::Value) -> CmdResult<Option<PlaylistItem>> {
    let state = app_state();
    ensure_playlist_mutable(state)?;
    let mut playlist = state.playlist_now();
    let Some(item) = playlist.iter_mut().find(|i| i.id == item_id) else {
        return Ok(None);
    };
    if let Some(v) = patch.get("selectedSubtitleId") {
        item.selected_subtitle_id = v.as_str().map(str::to_string);
    }
    if let Some(v) = patch.get("mode").and_then(|v| v.as_str()) {
        item.mode = v.to_string();
    }
    if let Some(v) = patch.get("syncOffsetSec").and_then(|v| v.as_f64()) {
        item.sync_offset_sec = v;
    }
    if let Some(v) = patch.get("subtitleDelaySec").and_then(|v| v.as_f64()) {
        item.subtitle_delay_sec = v;
    }
    let item = item.clone();
    state.engine().set_playlist(playlist);
    Ok(Some(item))
}

/* ------------------------------------------------------------------ *
 * engine
 * ------------------------------------------------------------------ */

#[tauri::command]
pub async fn engine_start() -> CmdResult<EngineStatus> {
    Ok(app_state().engine().start(None).await)
}

#[tauri::command]
pub async fn engine_stop() -> CmdResult<EngineStatus> {
    Ok(app_state().engine().stop().await)
}

#[tauri::command]
pub async fn engine_skip_next() -> CmdResult<EngineStatus> {
    Ok(app_state().engine().skip_next(None).await)
}

#[tauri::command]
pub async fn engine_jump_to_item(item_id: String) -> CmdResult<EngineStatus> {
    Ok(app_state().engine().jump_to_item(&item_id).await)
}

#[tauri::command]
pub fn engine_status() -> CmdResult<EngineStatus> {
    Ok(app_state().engine().get_status())
}

#[tauri::command]
pub fn engine_preview_command() -> CmdResult<String> {
    Ok(app_state().engine().get_command_preview())
}

/* ------------------------------------------------------------------ *
 * logs
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn log_get() -> CmdResult<Vec<LogEntry>> {
    Ok(app_state().logs.lock().expect("app logs lock").clone())
}

#[tauri::command]
pub fn log_clear() -> CmdResult<()> {
    app_state().logs.lock().expect("app logs lock").clear();
    Ok(())
}

/* ------------------------------------------------------------------ *
 * shell
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn shell_show_item(file_path: String) -> CmdResult<()> {
    let app = handle();
    if std::path::Path::new(&file_path).exists() {
        let resolved = crate::store::paths::resolve_path(&file_path);
        let _ = app.opener().reveal_item_in_dir(resolved);
    }
    Ok(())
}

/* ------------------------------------------------------------------ *
 * presets
 * ------------------------------------------------------------------ */

fn presets_payload() -> PresetsPayload {
    PresetsPayload {
        location: get_preset_location(),
        presets: [builtin_presets().to_vec(), list_presets()].concat(),
    }
}

#[tauri::command]
pub fn presets_get() -> CmdResult<PresetsPayload> {
    Ok(presets_payload())
}

#[tauri::command]
pub fn presets_save(name: String, settings: SessionSettings) -> CmdResult<PresetsPayload> {
    let state = app_state();
    let preset = save_preset(SavePresetInput { name, settings }).map_err(|e| e)?;
    state.push_log(
        "info",
        main_t_params("main.dialog.presetSaved", vec![("name", preset.name), ("path", get_preset_location().file)]),
    );
    Ok(presets_payload())
}

#[tauri::command]
pub fn presets_delete(preset_id: String) -> CmdResult<PresetsPayload> {
    let state = app_state();
    if builtin_presets().iter().any(|p| p.id == preset_id) {
        return Err(main_t("main.dialog.builtinNoDelete"));
    }
    let remaining = delete_preset(&preset_id)?;
    state.push_log("info", main_t_params("main.dialog.presetDeleted", vec![("n", remaining.len().to_string())]));
    Ok(presets_payload())
}

#[tauri::command]
pub fn presets_rename(preset_id: String, name: String) -> CmdResult<PresetsPayload> {
    if builtin_presets().iter().any(|p| p.id == preset_id) {
        return Err(main_t("main.dialog.builtinNoRename"));
    }
    rename_preset(&preset_id, &name)?;
    Ok(presets_payload())
}

#[tauri::command]
pub fn presets_open_dir() -> CmdResult<()> {
    let app = handle();
    let dir = get_preset_location().dir;
    let _ = std::fs::create_dir_all(&dir);
    let _ = app.opener().open_path(dir, None::<&str>);
    Ok(())
}

/* ------------------------------------------------------------------ *
 * persisted logs
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn logs_open_dir() -> CmdResult<()> {
    let app = handle();
    let dir = get_persisted_log_info().dir;
    let _ = std::fs::create_dir_all(&dir);
    let _ = app.opener().open_path(dir, None::<&str>);
    Ok(())
}

#[tauri::command]
pub fn logs_info() -> CmdResult<PersistedLogInfo> {
    Ok(get_persisted_log_info())
}

/* ------------------------------------------------------------------ *
 * obs-websocket compatible control server
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn obs_status() -> CmdResult<ObsWebSocketStatus> {
    Ok(app_state().obs().status())
}

#[tauri::command]
pub async fn obs_apply() -> CmdResult<ObsWebSocketStatus> {
    Ok(app_state().obs().apply().await)
}

/* ------------------------------------------------------------------ *
 * RTMP connection test
 * ------------------------------------------------------------------ */

#[tauri::command]
pub async fn test_rtmp(req: RtmpTestRequest) -> CmdResult<RtmpTestResult> {
    test_rtmp_impl(req).await
}

#[allow(clippy::too_many_lines)]
async fn test_rtmp_impl(req: RtmpTestRequest) -> CmdResult<RtmpTestResult> {
    let state = app_state();
    let settings = load_settings();
    let resolved = resolve_binaries(&settings.ffmpeg_path, &settings.ffprobe_path);
    if resolved.ffmpeg.is_empty() {
        return Ok(RtmpTestResult {
            ok: false,
            message: main_t("main.dialog.noFfmpegTest"),
            detail: String::new(),
            elapsed_ms: 0.0,
            summary: None,
            notes: None,
        });
    }

    let url = req.url.trim().to_string();
    let key = req.stream_key.trim().to_string();
    // Test the session the caller sent (the settings on screen); fall back to
    // the persisted ones so an older caller still gets a test.
    let requested = req.session.unwrap_or_else(|| settings.session.clone());
    // The protocol decides the address scheme the test accepts and how the key
    // travels; fall back to the address when the caller did not send one.
    let protocol = if requested.output.protocol.is_empty() {
        detect_stream_protocol(&url)
    } else {
        requested.output.protocol.clone()
    };
    let session = if protocol == requested.output.protocol {
        requested
    } else {
        let mut s = requested.clone();
        s.output.protocol = protocol.clone();
        s
    };
    if !address_matches_protocol(&url, Some(&protocol)) {
        return Ok(RtmpTestResult {
            ok: false,
            message: main_t_params("main.dialog.badUrlProtocol", vec![("schemes", protocol_schemes(&protocol).into())]),
            detail: String::new(),
            elapsed_ms: 0.0,
            summary: None,
            notes: None,
        });
    }
    // The stream key is optional: some servers take the whole path in the
    // address. Redact against the values THIS test used, not only the
    // persisted session: a caller may pass an address/key that has not been
    // saved yet.
    let mut test_output = session.output.clone();
    test_output.server = url.clone();
    test_output.stream_key = key.clone();
    let secrets = collect_secrets(Some(&test_output));
    // The summary and notes are shown in the UI, so the test is built in the
    // language the interface is running in.
    let test = build_test_command(&session, &url, &key, &get_language());
    let timeout_sec = if req.timeout_sec == 0.0 { 20.0 } else { req.timeout_sec };
    let timeout_ms = (timeout_sec.max(5.0).min(60.0) * 1000.0) as u64;
    state.push_log("debug", main_t_params("main.dialog.testTarget", vec![("target", mask_target(&url, &key, Some(&protocol)))]));
    state.push_log("debug", main_t_params("main.dialog.testParams", vec![("params", test.summary.join(" · "))]));
    for note in &test.notes {
        state.push_log("info", main_t_params("main.dialog.testNote", vec![("note", note.clone())]));
    }
    // The log sink redacts against the PERSISTED settings; the values being
    // tested may not be saved yet, so the command line is redacted against
    // this test's own secrets here.
    state.push_log(
        "debug",
        main_t_params(
            "main.dialog.testCommand",
            vec![("command", redact_text(&build_command_line(&resolved.ffmpeg, &test.args), &secrets))],
        ),
    );

    let started = now_ms();
    // The ffmpeg run has its own timeout; this guard only covers a hang below
    // runProcess so the test can never wedge the UI.
    let run = run_process(&resolved.ffmpeg, &test.args, timeout_ms);
    let guard_ms = timeout_ms + 5000;
    let timeout_result = match tokio::time::timeout(std::time::Duration::from_millis(guard_ms), run).await {
        Ok(result) => result,
        Err(_) => crate::ffmpeg::capabilities::RunResult {
            code: -3,
            stdout: String::new(),
            stderr: main_t("main.dialog.testAborted"),
        },
    };

    let elapsed_ms = now_ms() - started;
    let combined = format!("{}\n{}", timeout_result.stderr, timeout_result.stdout);
    let detail_lines: Vec<&str> = combined.lines().filter(|l| !l.trim().is_empty()).collect();
    let detail_start = detail_lines.len().saturating_sub(30);
    let detail = redact_text(&detail_lines[detail_start..].join("\n"), &secrets);
    let timed_out = timeout_result.code == -2 || timeout_result.code == -3;
    let failed_re = regex::Regex::new(
        r"(?i)Connection refused|Server error|Unauthorized|Cannot open connection|Unknown error|Connection reset|timed out|No route to host|Name or service not known|Immediate exit requested",
    )
    .expect("static regex");
    let ok = !timed_out && timeout_result.code == 0 && !failed_re.is_match(&combined);

    let message = if ok {
        main_t_params(
            "main.dialog.testOk",
            vec![("target", mask_target(&url, &key, Some(&protocol))), ("sec", format!("{:.1}", elapsed_ms / 1000.0))],
        )
    } else if timeout_result.code == -3 {
        main_t("main.dialog.testStuck")
    } else if timed_out {
        main_t_params("main.dialog.testTimeout", vec![("sec", format!("{}", timeout_ms as f64 / 1000.0))])
    } else {
        let err_line = combined.lines().rev().find(|l| failed_re.is_match(l));
        match err_line {
            Some(line) => redact_text(line.trim(), &secrets),
            None => main_t_params(
                "main.dialog.testFailed",
                vec![("code", timeout_result.code.to_string())],
            ),
        }
    };
    state.push_log(if ok { "info" } else { "error" }, main_t_params("main.dialog.result", vec![("message", message.clone())]));
    Ok(RtmpTestResult {
        ok,
        message,
        detail,
        elapsed_ms,
        summary: Some(test.summary),
        notes: Some(test.notes),
    })
}

// Silence unused warnings for the constants the settings merge owns centrally.
#[allow(unused)]
fn _keep_constants() {
    let _ = (BUFFER_SEC_MIN, BUFFER_SEC_MAX, BUFFER_SEC_DEFAULT, OBS_PORT_MIN, OBS_PORT_MAX, THEME_PREFERENCES);
}
