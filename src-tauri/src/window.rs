//! Window creation, theme sync, the streaming close-confirm and the E2E
//! window placement. Port of the window half of `src/main/index.ts`.

use crate::app::{main_t, APP};
use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

pub const WINDOW_LABEL: &str = "main";

/// Creates the main window. Built programmatically (rather than through
/// `tauri.conf.json`) because the portable `Data/` contract decides the
/// webview's user-data folder, and the window title follows the resolved
/// interface language. The window stays hidden until the background colour has
/// been synced with the current theme, so no wrong-palette frame is visible.
pub fn create_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let title = main_t("app.title");
    let builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::default())
        .title(title)
        .inner_size(1440.0, 940.0)
        .min_inner_size(1080.0, 720.0)
        .visible(false);
    // Shadow the builder on Windows instead of starting with `let mut`: CI denies
    // warnings, and `unused_mut` fires on Linux/macOS where this block is absent.
    #[cfg(windows)]
    let builder = {
        // The webview's own profile storage (cache, session) follows the same
        // portable contract as every other state file: Data/Cache, never the
        // user profile.
        let webview_data = crate::store::paths::cache_dir().join("webview");
        let _ = std::fs::create_dir_all(&webview_data);
        // Additional WebView2 browser arguments. The test harness injects CDP
        // and throttling switches through WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
        // setting our own here would override that variable, so merge both.
        let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
        if let Ok(extra) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            if !extra.is_empty() {
                args.push(' ');
                args.push_str(&extra);
            }
        }
        builder.data_directory(webview_data).additional_browser_args(&args)
    };
    let window = builder.build()?;

    // The window background must match the palette the renderer is about to
    // paint, or the app flashes the other theme on startup.
    sync_window_theme(app);

    // E2E runs set STREAMER_E2E=1: the window moves off-screen and becomes
    // click-through, so stray physical mouse input cannot perturb a test while
    // CDP keeps full control.
    if std::env::var("STREAMER_E2E").as_deref() == Ok("1") {
        let _ = window.set_position(LogicalPosition::new(-32000.0, -32000.0));
        let _ = window.set_ignore_cursor_events(true);
    }
    let _ = window.show();

    // While the appearance follows the system, the window keeps up with it too
    // — the renderer watches `prefers-color-scheme` for the same reason.
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::ThemeChanged(_) => {
            sync_window_theme(&handle);
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // While a session is live the close is cancelled and the user is
            // asked; the unload proceeds only when they choose to leave.
            api.prevent_close();
            let app = handle.clone();
            tauri::async_runtime::spawn(async move {
                handle_close_requested(app).await;
            });
        }
        _ => {}
    });

    Ok(())
}

/// The close flow: no live session → shut down and exit; a live session →
/// native confirm with the localized strings the dialog used to show.
async fn handle_close_requested(app: AppHandle) {
    let state = APP.get().expect("app state");
    if !state.engine().is_active() {
        crate::app::shutdown(&app).await;
        return;
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let leave = main_t("main.dialog.leaveWhileStreaming");
    let stay = main_t("main.dialog.stayWhileStreaming");
    let title = main_t("main.dialog.closeWhileStreamingTitle");
    let message = main_t("main.dialog.closeWhileStreaming");
    app.dialog()
        .message(message)
        .title(title)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(leave, stay))
        .show(move |choice| {
            let _ = tx.send(choice);
        });
    let leave_chosen = rx.await.unwrap_or(false);
    if leave_chosen {
        crate::app::shutdown(&app).await;
    }
}

/// Keeps the window's own colour in step with the appearance setting. The
/// window background must match or the app flashes the other palette while the
/// first paint is on its way. `system` asks the window itself, which is the
/// same signal the renderer's `prefers-color-scheme` resolves to.
pub fn sync_window_theme(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else { return };
    let Ok(system_dark) = window.theme().map(|t| t == tauri::Theme::Dark) else { return };
    let dark = match crate::store::settings::load_settings().theme.as_str() {
        "dark" => true,
        "system" => system_dark,
        _ => false,
    };
    let color = if dark {
        tauri::window::Color(0x09, 0x09, 0x0b, 0xff)
    } else {
        tauri::window::Color(0xff, 0xff, 0xff, 0xff)
    };
    let _ = window.set_background_color(Some(color));
}
