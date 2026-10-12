use crate::firmware_manager;
use crate::lora_protocol::*;
use crate::port_scanner::{PortScanner, ScanPace};
use crate::serial_manager::{ConnectError, SerialManager, STREAM_BUSY};
use crate::{log_error, log_info, log_warn};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;

const REPLY_TIMEOUT: Duration = Duration::from_secs(3);
/// Silence allowed between two lines of a streamed reply.
const STREAM_TIMEOUT: Duration = Duration::from_secs(5);
/// 4 MiB of recordings at ~250 bytes a line, with margin.
const STREAM_MAX_LINES: usize = 100_000;
/// Whole stream, and the wait for another one to finish. 4 MiB takes a few seconds.
const STREAM_DEADLINE: Duration = Duration::from_secs(60);

/// Marks the port as connecting so the scanner won't probe it: two opens of
/// the same COM port fail with os error 121 on Windows.
struct ConnectingGuard {
    state: Arc<Mutex<SerialManager>>,
}

impl ConnectingGuard {
    fn new(
        state: Arc<Mutex<SerialManager>>,
        scanner: &PortScanner,
        port_name: &str,
    ) -> Self {
        // Windows releases the handle some time after Drop; the scanner holds
        // `probing_path` until it is really free.
        let waited = scanner
            .wait_probe_clear(port_name, Duration::from_millis(3000));
        if waited {
            log_info(&format!(
                "serial_connect: waited for probe to finish on {}",
                port_name
            ));
        }

        if let Ok(mut mgr) = state.lock() {
            mgr.begin_connecting(port_name);
        }
        Self { state }
    }
}

impl Drop for ConnectingGuard {
    fn drop(&mut self) {
        if let Ok(mut mgr) = self.state.lock() {
            mgr.end_connecting();
        }
    }
}

/// std Mutex: never held across an await, and SerialManager::send releases
/// it before waiting for the reply.
type SharedManager = Arc<Mutex<SerialManager>>;

fn lock_mgr(state: &SharedManager) -> Result<std::sync::MutexGuard<'_, SerialManager>, String> {
    state
        .lock()
        .map_err(|_| "Mutex poisoned, restart the application".to_string())
}

/// Sync commands run on the main thread: anything that waits on the device
/// goes through here so the window stays responsive.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Task panic: {}", e))?
}

fn send(state: &SharedManager, cmd: &str, payload: Value) -> Result<DeviceMessage, String> {
    let reply = SerialManager::send(state, cmd, &payload.to_string(), REPLY_TIMEOUT, 0)?;
    match reply {
        DeviceMessage::Error { msg, .. } => Err(msg),
        other => Ok(other),
    }
}

/// Runs a streamed command and returns what came between `begin` and `end`.
fn collect_stream(
    state: &SharedManager,
    cmd: &str,
    payload: Value,
    drop_live_before_begin: bool,
) -> Result<Vec<Incoming>, String> {
    // One stream at a time: wait for the one in flight rather than fail.
    let waiting_since = Instant::now();
    let rx = loop {
        match lock_mgr(state)?.start_stream(cmd, &payload.to_string(), drop_live_before_begin) {
            Ok(rx) => break rx,
            Err(e) if e == STREAM_BUSY && waiting_since.elapsed() < STREAM_DEADLINE => {}
            Err(e) => return Err(e),
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let end_stream = || {
        if let Ok(mut mgr) = state.lock() {
            mgr.end_stream();
        }
    };

    let started = Instant::now();
    let mut items = Vec::new();
    loop {
        if started.elapsed() > STREAM_DEADLINE {
            end_stream();
            return Err(format!("{}: no end after {} s", cmd, STREAM_DEADLINE.as_secs()));
        }
        match rx.recv_timeout(STREAM_TIMEOUT) {
            Ok(Ok(Incoming::Reply(DeviceMessage::Ack { phase, .. }))) => {
                if phase.as_deref() == Some("end") {
                    return Ok(items);
                }
            }
            Ok(Ok(Incoming::Reply(DeviceMessage::Error { msg, .. }))) => return Err(msg),
            Ok(Ok(item)) => {
                items.push(item);
                if items.len() >= STREAM_MAX_LINES {
                    end_stream();
                    return Err(format!("{}: more than {} lines", cmd, STREAM_MAX_LINES));
                }
            }
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                end_stream();
                return Err(format!(
                    "{}: nothing received for {} s",
                    cmd,
                    STREAM_TIMEOUT.as_secs()
                ));
            }
        }
    }
}

#[tauri::command]
pub fn get_platform() -> &'static str {
    if cfg!(target_os = "windows") { "windows" }
    else if cfg!(target_os = "macos") { "macos" }
    else if cfg!(target_os = "linux") { "linux" }
    else { "other" }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TimeSyncResult {
    /// |device - pc| in seconds; 0 if the device clock was invalid.
    pub drift_s: f64,
    /// Device reported valid=false (clock never set).
    pub was_invalid: bool,
    pub did_sync: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub firmware: FirmwareInfo,
    pub profile: Value,
    pub clock: TimeSyncResult,
}

/// Opens the port, identifies a Link-LR, sets its clock and reads its profile.
/// The sessions are read next by the frontend, then the live lines follow.
#[tauri::command]
pub async fn serial_connect(
    state: State<'_, SharedManager>,
    scanner: State<'_, Arc<PortScanner>>,
    port_name: String,
    utc: i64,
    offset_min: i32,
    on_event: Channel<SerialEvent>,
) -> Result<ConnectInfo, ConnectError> {
    let state = state.inner().clone();
    let scanner = scanner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        connect_blocking(&state, &scanner, &port_name, utc, offset_min, on_event)
    })
    .await
    .map_err(|e| ConnectError::Other {
        port: String::new(),
        raw: format!("Task panic: {}", e),
    })?
}

fn connect_blocking(
    state: &SharedManager,
    scanner: &PortScanner,
    port_name: &str,
    utc: i64,
    offset_min: i32,
    on_event: Channel<SerialEvent>,
) -> Result<ConnectInfo, ConnectError> {
    let _connecting_guard = ConnectingGuard::new(state.clone(), scanner, port_name);

    let fail = |step: &str, e: String| {
        log_error(&format!("Connect failed port={}: {}: {}", port_name, step, e));
        if let Ok(mut mgr) = state.lock() {
            mgr.disconnect();
        }
        ConnectError::Other {
            port: port_name.to_string(),
            raw: format!("{}: {}", step, e),
        }
    };

    lock_mgr(state)
        .map_err(|e| fail("lock", e))?
        .connect(port_name, on_event, state.clone())
        .inspect_err(|e| log_error(&format!("Connect failed port={}: {}", port_name, e)))?;

    // The Windows USB-serial driver may pulse DTR/RTS for ~100 ms after open;
    // a command sent earlier can be lost and time out.
    std::thread::sleep(Duration::from_millis(100));

    let firmware = identify(state).map_err(|e| fail("get_version", e))?;
    if firmware.kind != DeviceKind::LinkLr {
        log_warn(&format!(
            "Connect refused port={}: product={:?} model={:?}",
            port_name, firmware.product, firmware.model
        ));
        if let Ok(mut mgr) = state.lock() {
            mgr.disconnect();
        }
        return Err(ConnectError::UnsupportedDevice {
            port: port_name.to_string(),
            raw: format!(
                "{} {}",
                firmware.product.as_deref().unwrap_or("?"),
                firmware.model.as_deref().unwrap_or("?")
            ),
            kind: firmware.kind,
        });
    }

    // Before reading the sessions: set_time closes the running one.
    let clock = sync_time(state, utc, offset_min).map_err(|e| fail("clock", e))?;
    let profile = read_profile(state).map_err(|e| fail("get_profile", e))?;

    log_info(&format!(
        "Connect port={} OK model={} version={}",
        port_name,
        firmware.model.as_deref().unwrap_or("?"),
        firmware.version.as_deref().unwrap_or("?")
    ));
    Ok(ConnectInfo { firmware, profile, clock })
}

fn identify(state: &SharedManager) -> Result<FirmwareInfo, String> {
    // Six tries, 1 s apart: a device plugged in just before the click is
    // still booting and refuses writes with os error 121.
    let payload = json!({ "cmd": "get_version" }).to_string();
    match SerialManager::send(state, "get_version", &payload, REPLY_TIMEOUT, 6)? {
        DeviceMessage::Ack {
            version,
            build_date,
            product,
            model,
            mac,
            ..
        } => Ok(FirmwareInfo {
            kind: DeviceKind::from_version_ack(product.as_deref(), model.as_deref()),
            product,
            model,
            version,
            build_date,
            mac,
        }),
        DeviceMessage::Error { msg, .. } => Err(msg),
        _ => Err("unexpected reply".to_string()),
    }
}

/// Sets the device clock if it is invalid or drifts more than 30 s.
fn sync_time(state: &SharedManager, utc: i64, offset_min: i32) -> Result<TimeSyncResult, String> {
    const DRIFT_THRESHOLD_S: f64 = 30.0;

    let (device_utc, valid) = match send(state, "get_time", json!({ "cmd": "get_time" }))? {
        DeviceMessage::Time { utc, valid, .. } => (utc, valid.unwrap_or(false)),
        _ => return Err("Unexpected reply to get_time".to_string()),
    };
    let drift_s = if valid { (device_utc - utc as f64).abs() } else { 0.0 };

    if valid && drift_s <= DRIFT_THRESHOLD_S {
        return Ok(TimeSyncResult { drift_s, was_invalid: false, did_sync: false });
    }

    send(
        state,
        "set_time",
        json!({ "cmd": "set_time", "utc": utc, "offset_min": offset_min }),
    )
    .map_err(|e| format!("set_time rejected: {}", e))?;
    log_info(&format!("Clock set (drift={:.1}s, was_invalid={})", drift_s, !valid));
    Ok(TimeSyncResult { drift_s, was_invalid: !valid, did_sync: true })
}

fn read_profile(state: &SharedManager) -> Result<Value, String> {
    match send(state, "get_profile", json!({ "cmd": "get_profile" }))? {
        DeviceMessage::Ack { profile: Some(p), .. } => Ok(p),
        _ => Err("get_profile: no profile in reply".to_string()),
    }
}

#[tauri::command]
pub fn serial_disconnect(state: State<'_, SharedManager>) -> Result<(), String> {
    let mut mgr = lock_mgr(state.inner())?;
    mgr.disconnect();
    log_info("Disconnect (user)");
    Ok(())
}

#[tauri::command]
pub async fn get_profile(state: State<'_, SharedManager>) -> Result<Value, String> {
    let state = state.inner().clone();
    blocking(move || read_profile(&state)).await
}

/// `profile` holds only the fields to change; the device checks them all
/// before applying any, and closes the session. Returns the profile as applied.
#[tauri::command]
pub async fn set_profile(state: State<'_, SharedManager>, profile: Value) -> Result<Value, String> {
    let state = state.inner().clone();
    blocking(move || {
        let reply = send(&state, "set_profile", json!({ "cmd": "set_profile", "profile": profile }))
            .inspect_err(|e| log_warn(&format!("set_profile rejected: {}", e)))?;
        match reply {
            DeviceMessage::Ack { profile: Some(p), .. } => {
                log_info(&format!("set_profile OK {}", p));
                Ok(p)
            }
            _ => Err("set_profile: no profile in reply".to_string()),
        }
    })
    .await
}

/// Puts a frame on air. The outcome arrives later as a live `tx` line.
#[tauri::command]
pub async fn transmit(state: State<'_, SharedManager>, hex: String) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || send(&state, "tx", json!({ "cmd": "tx", "value": hex })).map(|_| ())).await
}

/// `session_info` lines, oldest first.
#[tauri::command]
pub async fn get_sessions(state: State<'_, SharedManager>) -> Result<Vec<Value>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let infos: Vec<Value> = collect_stream(&state, "get_sessions", json!({ "cmd": "get_sessions" }), false)?
            .into_iter()
            .filter_map(|i| match i {
                Incoming::SessionInfo(v) => Some(v),
                _ => None,
            })
            .collect();
        let current = infos
            .iter()
            .find(|v| v.get("current").and_then(|c| c.as_bool()) == Some(true))
            .and_then(|v| v.get("id").and_then(|id| id.as_u64()));
        lock_mgr(&state)?.set_live_session_id(current);
        Ok(infos)
    })
    .await
}

/// A session's lines as recorded. For the running session, the live lines
/// carry on from the last one returned, with no gap and no duplicate.
#[tauri::command]
pub async fn get_session(state: State<'_, SharedManager>, id: u64) -> Result<Vec<Value>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let running = lock_mgr(&state)?.live_session_id() == Some(id);
        let lines = collect_stream(&state, "get_session", json!({ "cmd": "get_session", "id": id }), running)?
            .into_iter()
            .filter_map(|i| match i {
                Incoming::Record(v) => Some(v),
                _ => None,
            })
            .collect();
        Ok(lines)
    })
    .await
}

#[tauri::command]
pub async fn erase_sessions(state: State<'_, SharedManager>) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        send(&state, "erase_sessions", json!({ "cmd": "erase_sessions" }))?;
        log_info("Recordings erased");
        Ok(())
    })
    .await
}

/// The device's event log.
#[tauri::command]
pub async fn get_events(state: State<'_, SharedManager>) -> Result<Vec<EventLogEntry>, String> {
    let state = state.inner().clone();
    blocking(move || {
        let entries = collect_stream(&state, "get_events", json!({ "cmd": "get_events" }), false)?
            .into_iter()
            .filter_map(|i| match i {
                Incoming::Reply(DeviceMessage::Event { line, seq }) => Some((line, seq)),
                _ => None,
            })
            .enumerate()
            .map(|(n, (line, seq))| EventLogEntry { line, seq: seq.unwrap_or(n as u32) })
            .collect();
        Ok(entries)
    })
    .await
}

// ============================================================
// Port scan (logic in port_scanner.rs; changes go out on `ports_changed`)
// ============================================================

#[tauri::command]
pub fn get_current_ports(scanner: State<'_, Arc<PortScanner>>) -> Vec<PortInfo> {
    scanner.current_ports()
}

#[tauri::command]
pub fn set_scan_pace(scanner: State<'_, Arc<PortScanner>>, active: bool) {
    let pace = if active { ScanPace::Active } else { ScanPace::Idle };
    scanner.set_pace(pace);
}

#[tauri::command]
pub fn refresh_ports_now(scanner: State<'_, Arc<PortScanner>>) {
    scanner.trigger_refresh();
}

// ============================================================
// Firmware update
// ============================================================

#[tauri::command]
pub async fn get_device_version(state: State<'_, SharedManager>) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    blocking(move || {
        if !lock_mgr(&state)?.is_connected() {
            return Err("Not connected".to_string());
        }
        match send(&state, "get_version", json!({ "cmd": "get_version" })) {
            Ok(DeviceMessage::Ack { version, .. }) => Ok(version),
            _ => Ok(None),
        }
    })
    .await
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FlashProgress {
    pub status: String,
    pub bytes_sent: u64,
    pub total_bytes: u64,
    pub percent: f64,
}

#[tauri::command]
pub async fn flash_firmware(
    state: State<'_, SharedManager>,
    firmware_path: String,
    on_progress: Channel<FlashProgress>,
) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || flash_firmware_blocking(&state, &firmware_path, &on_progress)).await
}

fn flash_firmware_blocking(
    state: &SharedManager,
    firmware_path: &str,
    on_progress: &Channel<FlashProgress>,
) -> Result<(), String> {
    use base64::Engine;

    let path = std::path::PathBuf::from(firmware_path);
    let firmware_data = std::fs::read(&path)
        .map_err(|e| format!("Firmware read failed: {}", e))?;
    let total_size = firmware_data.len() as u64;
    let sha256 = firmware_manager::compute_sha256(&path)?;

    let timeout_short = Duration::from_secs(5);
    let timeout_long = Duration::from_secs(10);
    let progress = |status: &str, bytes_sent: u64| {
        let _ = on_progress.send(FlashProgress {
            status: status.to_string(),
            bytes_sent,
            total_bytes: total_size,
            percent: bytes_sent as f64 / total_size as f64 * 100.0,
        });
    };
    let send_ota = |cmd: &str, payload: Value, timeout: Duration, retries: u32| {
        match SerialManager::send(state, cmd, &payload.to_string(), timeout, retries)? {
            DeviceMessage::Error { msg, .. } => Err(format!("{} failed: {}", cmd, msg)),
            _ => Ok(()),
        }
    };

    progress("starting", 0);
    send_ota(
        "ota_begin",
        json!({ "cmd": "ota_begin", "size": total_size, "sha256": sha256 }),
        timeout_long,
        1,
    )?;

    // 4 KiB of base64 stays under the device's 6 KiB line limit.
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut bytes_sent: u64 = 0;
    for chunk in firmware_data.chunks(4096) {
        send_ota("ota_data", json!({ "cmd": "ota_data", "data": b64.encode(chunk) }), timeout_short, 0)?;
        bytes_sent += chunk.len() as u64;
        progress("flashing", bytes_sent);
    }

    send_ota("ota_end", json!({ "cmd": "ota_end" }), timeout_long, 0)?;

    progress("rebooting", total_size);
    let _ = send_ota("reboot", json!({ "cmd": "reboot" }), timeout_short, 0);
    progress("done", total_size);

    Ok(())
}
