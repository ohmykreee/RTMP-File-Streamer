//! Persists the run log to disk (JSON Lines, one file per app launch, rotated
//! and size-capped). Port of `src/main/store/logger.ts`.

use crate::shared::types::LogEntry;
use crate::store::paths::{ensure_dir, logs_dir};
use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const TOTAL_BUDGET_BYTES: u64 = 12 * 1024 * 1024; // 12 MB across all session files
const MAX_SINGLE_FILE_BYTES: u64 = 4 * 1024 * 1024; // roll over past this per file
const MAX_SESSION_FILES: usize = 20;

struct LoggerState {
    file: Option<std::fs::File>,
    current_file: String,
    bytes_written: u64,
    buffered: Vec<String>,
    enabled: bool,
    /// Set by the shutdown path: late log lines must not reopen a session file
    /// that nobody will close.
    closed: bool,
    last_flush: std::time::Instant,
    /// Guards the lazy flush task: one at a time, like the TS flush timer.
    flush_pending: bool,
}

static LOGGER: Mutex<Option<LoggerState>> = Mutex::new(None);

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// ISO-like local timestamp; each field padded to exactly its natural width.
pub fn iso_timestamp(ts_ms: u64) -> String {
    let t = chrono::DateTime::from_timestamp_millis(ts_ms as i64)
        .unwrap_or_else(chrono::Utc::now)
        .with_timezone(&chrono::Local);
    t.format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
}

/// Deletes the oldest session files until the folder fits the budget.
/// `current_file` is passed in because this runs while the logger lock is
/// held (std Mutex is not reentrant — locking it here deadlocked bootstrap).
fn rotate(current_file: &str) {
    let dir = logs_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with("session-") && name.ends_with(".log")
        })
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((e.path(), meta.len(), meta.modified().ok()?))
        })
        .collect();
    files.sort_by_key(|(_, _, mtime)| *mtime); // oldest first
    let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
    let mut count = files.len();

    for (path, size, _) in files {
        if total <= TOTAL_BUDGET_BYTES && count <= MAX_SESSION_FILES {
            break;
        }
        if path.to_string_lossy().into_owned() == current_file {
            continue; // never delete the active file
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= size;
            count -= 1;
        }
    }
}

fn write_raw(state: &mut LoggerState, line: &str) {
    let payload = format!("{line}\n");
    let payload_len = payload.len() as u64;
    if state.bytes_written + payload_len > MAX_SINGLE_FILE_BYTES {
        // Roll over to a new file rather than letting one session grow unbounded.
        state.file = None;
        open_session_locked(state, "rollover: previous file reached the size cap");
        if state.file.is_none() {
            return;
        }
    }
    if let Some(file) = state.file.as_mut() {
        if file.write_all(payload.as_bytes()).is_err() {
            state.enabled = false;
            state.file = None;
            return;
        }
        state.bytes_written += payload_len;
    }
}

fn open_session_locked(state: &mut LoggerState, reason: &str) {
    if !state.enabled || state.closed {
        return;
    }
    let dir = logs_dir();
    if !ensure_dir(&dir) {
        state.enabled = false;
        return;
    }
    let file_path = dir.join(format!("session-{}.log", stamp()));
    let file = match OpenOptions::new().create(true).append(true).open(&file_path) {
        Ok(f) => f,
        Err(_) => {
            state.enabled = false;
            return;
        }
    };
    state.file = Some(file);
    state.current_file = file_path.to_string_lossy().into_owned();
    state.bytes_written = 0;
    rotate(&state.current_file);

    // Open every session with the context needed to interpret it later.
    let platform = format!("{} {} rust", std::env::consts::OS, std::env::consts::ARCH);
    for line in [
        "# RTMP File Streamer log session".to_string(),
        format!("# started   : {}", iso_timestamp(now_millis())),
        format!("# reason    : {reason}"),
        format!("# appRoot   : {}", crate::store::paths::app_root().to_string_lossy()),
        format!("# platform  : {platform}"),
    ] {
        write_raw(state, &line);
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn start_log_session(reason: &str) {
    let mut guard = LOGGER.lock().expect("logger lock");
    let state = guard.get_or_insert_with(|| LoggerState {
        file: None,
        current_file: String::new(),
        bytes_written: 0,
        buffered: Vec::new(),
        enabled: true,
        closed: false,
        last_flush: std::time::Instant::now(),
        flush_pending: false,
    });
    if state.file.is_none() && !state.closed {
        open_session_locked(state, reason);
    }
}

/// Converts one entry into a stable JSONL record and buffers it; the flush is
/// lazy (every 1.2 s or on close), like the TS writer's timer.
pub fn append_log_entry(entry: &LogEntry, extra: Option<(&str, &str)>) {
    let mut record = json!({
        "ts": iso_timestamp(entry.ts as u64),
        "level": entry.level,
        "message": entry.message,
    });
    if let Some((item, file)) = extra {
        if !item.is_empty() {
            record["item"] = json!(item);
        }
        if !file.is_empty() {
            record["file"] = json!(file);
        }
    }
    let line = record.to_string();
    let mut guard = LOGGER.lock().expect("logger lock");
    let needs_open = !guard.as_ref().map(|s| s.enabled && !s.closed).unwrap_or(false);
    if needs_open {
        return;
    }
    let state = guard.as_mut().expect("initialized above");
    if state.file.is_none() {
        open_session_locked(state, "first entry");
    }
    state.buffered.push(line);
    if state.last_flush.elapsed() >= std::time::Duration::from_millis(1200) {
        flush_locked(state);
    } else if !state.flush_pending {
        // The TS writer relied on a 1.2 s flush timer; schedule the same lazy
        // flush so the tail of a burst lands even when nothing follows it.
        state.flush_pending = true;
        let deadline = std::time::Duration::from_millis(1200) - state.last_flush.elapsed();
        // A plain thread, not a runtime task: the logger is also driven during
        // bootstrap on the main thread, where no tokio context exists.
        std::thread::spawn(move || {
            std::thread::sleep(deadline);
            if let Ok(mut guard) = LOGGER.lock() {
                if let Some(state) = guard.as_mut() {
                    state.flush_pending = false;
                    flush_locked(state);
                }
            }
        });
    }
}

fn flush_locked(state: &mut LoggerState) {
    let batch = std::mem::take(&mut state.buffered);
    for line in batch {
        write_raw(state, &line);
    }
    state.last_flush = std::time::Instant::now();
}

pub fn get_persisted_log_info() -> crate::shared::types::PersistedLogInfo {
    let dir = logs_dir();
    let (current_file, current_bytes, budget) = {
        let guard = LOGGER.lock().expect("logger lock");
        (
            guard.as_ref().map(|s| s.current_file.clone()).unwrap_or_default(),
            guard.as_ref().map(|s| s.bytes_written).unwrap_or(0),
            TOTAL_BUDGET_BYTES,
        )
    };
    let mut total_bytes = 0u64;
    let mut file_count = 0u32;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with("session-") || !name.ends_with(".log") {
                continue;
            }
            if let Ok(meta) = e.metadata() {
                // The current session file is still open for writing, and the
                // size the directory reports for it can lag behind what has
                // actually been written (it catches up when the handle
                // closes). The logger knows the exact figure; everything else
                // on disk is a closed file, where the directory is accurate.
                let size = if e.path().to_string_lossy() == current_file {
                    current_bytes
                } else {
                    meta.len()
                };
                total_bytes += size;
                file_count += 1;
            }
        }
    };
    crate::shared::types::PersistedLogInfo {
        dir: dir.to_string_lossy().into_owned(),
        current_file,
        total_bytes,
        file_count,
        budget_bytes: budget,
    }
}

/// Forces buffered lines out (the TS writer flushed every 1.2 s via a timer;
/// the Rust side flushes lazily on append and eagerly here).
pub fn flush_now() {
    if let Ok(mut guard) = LOGGER.lock() {
        if let Some(state) = guard.as_mut() {
            flush_locked(state);
        }
    }
}

pub fn close_log_session() {
    if let Ok(mut guard) = LOGGER.lock() {
        if let Some(state) = guard.as_mut() {
            state.closed = true;
            flush_locked(state);
            if state.file.is_some() {
                write_raw(state, &format!("# ended     : {}", iso_timestamp(now_millis())));
                state.file = None;
            }
        }
    }
}
