//! Store write failures surface in the log rather than only on stderr.
//! Port of `src/main/store/errors.ts`.

use std::sync::Mutex;

pub type StoreArea = &'static str; // 'settings' | 'presets' | 'playlist' | 'logs'

type StoreErrorHandler = Box<dyn Fn(StoreArea, &str) + Send + Sync>;

static HANDLER: Mutex<Option<StoreErrorHandler>> = Mutex::new(None);

pub fn set_store_error_handler<F: Fn(StoreArea, &str) + Send + Sync + 'static>(f: F) {
    *HANDLER.lock().expect("store error handler lock") = Some(Box::new(f));
}

pub fn report_store_error(area: StoreArea, error: &str) {
    eprintln!("[{area}] write failed: {error}");
    if let Some(handler) = HANDLER.lock().expect("store error handler lock").as_ref() {
        handler(area, error);
    }
}
