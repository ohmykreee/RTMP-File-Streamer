//! RTMP File Streamer — Tauri backend (Rust port of the former Electron main
//! process). The renderer-facing commands live in `ipc.rs`, the window in
//! `window.rs`, the service wiring in `app.rs`; everything else is portable
//! logic the cargo tests drive directly.

pub mod app;
pub mod build_info;
pub mod ffmpeg;
pub mod ipc;
pub mod log_redact;
pub mod obs;
pub mod shared;
pub mod store;
pub mod stream;
pub mod window;

/// The tokio runtime the backend runs on. The engine and the playout spawn
/// tasks that need a multi-thread runtime; the Tauri shell uses Tauri's own
/// async runtime, and the cargo tests build their own with this.
pub fn build_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        // Single instance must be the first plugin: two streaming sessions
        // pushing the same key would fight. A second launch restores/focuses
        // the window instead of starting a second engine.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window(crate::window::WINDOW_LABEL) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            crate::app::bootstrap(app)?;
            crate::window::create_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::get_app_info,
            ipc::get_settings,
            ipc::save_settings,
            ipc::set_language,
            ipc::get_app_capabilities,
            ipc::pick_ffmpeg,
            ipc::pick_video_files,
            ipc::pick_subtitle_files,
            ipc::probe,
            ipc::playlist_get,
            ipc::playlist_add,
            ipc::playlist_attach_subtitle,
            ipc::playlist_remove,
            ipc::playlist_clear,
            ipc::playlist_reorder,
            ipc::playlist_update_item,
            ipc::engine_start,
            ipc::engine_stop,
            ipc::engine_skip_next,
            ipc::engine_jump_to_item,
            ipc::engine_status,
            ipc::engine_preview_command,
            ipc::log_get,
            ipc::log_clear,
            ipc::shell_show_item,
            ipc::presets_get,
            ipc::presets_save,
            ipc::presets_delete,
            ipc::presets_rename,
            ipc::presets_open_dir,
            ipc::logs_open_dir,
            ipc::logs_info,
            ipc::obs_status,
            ipc::obs_apply,
            ipc::test_rtmp,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Quitting must not leave ffmpeg pushing. The close button goes
            // through the window's close-requested handler; this covers paths
            // that bypass it (system logout, `app.exit`).
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let handle = _app.clone();
                tauri::async_runtime::block_on(async move {
                    crate::app::shutdown(&handle).await;
                });
            }
        });
}
