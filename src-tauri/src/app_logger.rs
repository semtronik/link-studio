//! Persistent app log under `<app_data_dir>/logs/app.log`, mirrored to stderr.
//! DEBUG goes to the file only with `LINK_STUDIO_DEBUG=1`; the file rotates to
//! `app.log.1` past `ROTATE_BYTES`.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use tauri::{AppHandle, Manager};

const ROTATE_BYTES: u64 = 1024 * 1024; // 1 MB

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn as_str(&self) -> &'static str {
        match self {
            LogLevel::Debug => "DEBUG",
            LogLevel::Info => "INFO ",
            LogLevel::Warn => "WARN ",
            LogLevel::Error => "ERROR",
        }
    }
}

struct LoggerState {
    file_path: PathBuf,
    rotated_path: PathBuf,
    file: Mutex<Option<File>>,
    debug_to_file: bool,
}

static LOGGER: OnceLock<LoggerState> = OnceLock::new();

/// On failure the file logger stays disabled; stderr output still works.
pub fn init(app: &AppHandle) {
    let result = (|| -> Result<LoggerState, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {}", e))?;
        let logs_dir = data_dir.join("logs");
        fs::create_dir_all(&logs_dir)
            .map_err(|e| format!("create_dir_all {}: {}", logs_dir.display(), e))?;

        let file_path = logs_dir.join("app.log");
        let rotated_path = logs_dir.join("app.log.1");

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .map_err(|e| format!("open {}: {}", file_path.display(), e))?;

        let debug_to_file = std::env::var("LINK_STUDIO_DEBUG")
            .ok()
            .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);

        Ok(LoggerState {
            file_path,
            rotated_path,
            file: Mutex::new(Some(file)),
            debug_to_file,
        })
    })();

    match result {
        Ok(state) => {
            let _ = LOGGER.set(state);
            log_info(&format!("=== App started (v{}) ===", env!("CARGO_PKG_VERSION")));
        }
        Err(e) => {
            eprintln!("[app_logger] init failed: {} — logging disabled", e);
        }
    }
}

fn timestamp_now() -> String {
    let now = SystemTime::now();
    let secs = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // UTC, via Hinnant's civil-from-days algorithm.
    let days = secs / 86400;
    let secs_today = secs % 86400;
    let h = secs_today / 3600;
    let m = (secs_today / 60) % 60;
    let s = secs_today % 60;

    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        y, mo, d, h, m, s
    )
}

fn write_line(level: LogLevel, message: &str) {
    let line = format!("{} {} {}\n", timestamp_now(), level.as_str(), message);

    eprint!("{}", line);

    let Some(state) = LOGGER.get() else {
        return;
    };

    if level == LogLevel::Debug && !state.debug_to_file {
        return;
    }

    let mut guard = match state.file.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };

    // If the rename fails, keep writing to the current file.
    if let Some(file) = guard.as_mut() {
        if let Ok(metadata) = file.metadata() {
            if metadata.len() >= ROTATE_BYTES {
                *guard = None;
                let _ = fs::rename(&state.file_path, &state.rotated_path);
                if let Ok(new_file) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&state.file_path)
                {
                    *guard = Some(new_file);
                }
            }
        }
    }

    if let Some(file) = guard.as_mut() {
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
}

pub fn log_debug(message: &str) {
    write_line(LogLevel::Debug, message);
}

pub fn log_info(message: &str) {
    write_line(LogLevel::Info, message);
}

pub fn log_warn(message: &str) {
    write_line(LogLevel::Warn, message);
}

pub fn log_error(message: &str) {
    write_line(LogLevel::Error, message);
}
