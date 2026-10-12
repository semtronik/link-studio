use crate::firmware_manager;
use crate::lora_protocol::*;
use crate::port_scanner::{PortScanner, ScanPace};
use crate::serial_manager::{ConnectError, SerialManager};
use crate::{log_error, log_info, log_warn};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

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
            .wait_probe_clear(port_name, std::time::Duration::from_millis(3000));
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

/// std Mutex: never held across an await, and send_command_safe releases it
/// before waiting for the reply.
type SharedManager = Arc<Mutex<SerialManager>>;

fn lock_mgr(state: &SharedManager) -> Result<std::sync::MutexGuard<'_, SerialManager>, String> {
    state
        .lock()
        .map_err(|_| "Mutex poisoned, restart the application".to_string())
}

#[tauri::command]
pub fn get_platform() -> &'static str {
    if cfg!(target_os = "windows") { "windows" }
    else if cfg!(target_os = "macos") { "macos" }
    else if cfg!(target_os = "linux") { "linux" }
    else { "other" }
}

#[tauri::command]
pub fn serial_connect(
    state: State<'_, SharedManager>,
    scanner: State<'_, Arc<PortScanner>>,
    port_name: String,
    baud_rate: Option<u32>,
    on_event: Channel<SerialEvent>,
) -> Result<LoRaConfig, ConnectError> {
    let baud = baud_rate.unwrap_or(115200);
    let state_clone = state.inner().clone();

    let _connecting_guard =
        ConnectingGuard::new(state.inner().clone(), scanner.inner(), &port_name);

    let other = |raw: String| ConnectError::Other {
        port: port_name.clone(),
        raw,
    };

    let event_channel = on_event.clone();

    {
        let mut mgr = lock_mgr(state.inner()).map_err(&other)?;
        if let Err(e) = mgr.connect(&port_name, baud, on_event, state_clone) {
            log_error(&format!("Connect failed port={}: {}", port_name, e));
            return Err(e);
        }
    }

    // The Windows USB-serial driver may pulse DTR/RTS for ~100 ms after open;
    // a command sent earlier can be lost and time out.
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Six tries, 1 s apart: a device plugged in just before the click is
    // still booting and refuses writes with os error 121.
    let firmware_info = match identify(state.inner()) {
        Ok(info) => info,
        Err(e) => {
            log_error(&format!("Connect failed port={}: get_version error: {}", port_name, e));
            if let Ok(mut mgr) = state.inner().lock() {
                mgr.disconnect();
            }
            return Err(other(format!("get_version: {}", e)));
        }
    };
    if firmware_info.kind != DeviceKind::LinkLr {
        log_warn(&format!(
            "Connect refused port={}: product={:?} model={:?}",
            port_name, firmware_info.product, firmware_info.model
        ));
        if let Ok(mut mgr) = state.inner().lock() {
            mgr.disconnect();
        }
        return Err(ConnectError::UnsupportedDevice {
            port: port_name.clone(),
            raw: format!(
                "{} {}",
                firmware_info.product.as_deref().unwrap_or("?"),
                firmware_info.model.as_deref().unwrap_or("?")
            ),
            kind: firmware_info.kind,
        });
    }
    let _ = event_channel.send(SerialEvent::Firmware(firmware_info.clone()));
    log_info(&format!(
        "Connect port={} OK model={} version={}",
        port_name,
        firmware_info.model.as_deref().unwrap_or("?"),
        firmware_info.version.as_deref().unwrap_or("?")
    ));

    let cmd = SerialCommand {
        cmd: "get_config".to_string(),
        value: None,
    };
    let resp = match SerialManager::send_command_safe(state.inner(), cmd) {
        Ok(r) => r,
        Err(e) => {
            log_error(&format!("Connect failed port={}: get_config error: {}", port_name, e));
            if let Ok(mut mgr) = state.inner().lock() {
                mgr.disconnect();
            }
            return Err(other(format!("get_config: {}", e)));
        }
    };

    let config = match resp {
        DeviceMessage::Config {
            freq,
            sf,
            bw,
            drops,
        } => {
            let prev = LoRaConfig {
                freq: 868.0,
                sf: 7,
                bw: 125.0,
                drops: 0,
            };
            let config = LoRaConfig {
                freq: freq.unwrap_or(prev.freq),
                sf: sf.unwrap_or(prev.sf),
                bw: bw.unwrap_or(prev.bw),
                drops: drops.unwrap_or(prev.drops),
            }.sanitized();
            let mut mgr = lock_mgr(state.inner()).map_err(&other)?;
            mgr.config = Some(config.clone());
            drop(mgr);
            config
        }
        _ => {
            if let Ok(mut mgr) = state.inner().lock() {
                mgr.disconnect();
            }
            return Err(other("get_config_unexpected_response".to_string()));
        }
    };

    // The frontend calls `sync_time` on the Firmware event: the local
    // offset is easier to read in JS.

    Ok(config)
}

fn identify(state: &SharedManager) -> Result<FirmwareInfo, String> {
    let cmd = SerialCommand {
        cmd: "get_version".to_string(),
        value: None,
    };
    match SerialManager::send_command_safe_with_retries(state, cmd, 6)? {
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
        _ => Err("unexpected reply".to_string()),
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TimeSyncResult {
    /// Clock already valid and on time: no set_time sent.
    pub was_in_sync: bool,
    /// |device - pc| in seconds; 0 if the device clock was invalid.
    pub drift_s: f64,
    /// Device reported valid=false (RTC never set).
    pub was_invalid: bool,
    pub did_sync: bool,
}

/// Sets the device clock if it is invalid or drifts more than 30 s.
/// Called by the frontend once the device is identified.
#[tauri::command]
pub fn sync_time(
    state: State<'_, SharedManager>,
    utc: i64,
    offset_min: i32,
) -> Result<TimeSyncResult, String> {
    const DRIFT_THRESHOLD_S: f64 = 30.0;

    let resp = SerialManager::send_command_safe(
        state.inner(),
        SerialCommand {
            cmd: "get_time".to_string(),
            value: None,
        },
    )?;

    let (device_utc, device_valid) = match resp {
        DeviceMessage::Time { utc, valid, .. } => (utc, valid.unwrap_or(false)),
        _ => return Err("Unexpected reply to get_time".to_string()),
    };

    let drift_s = if device_valid {
        (device_utc - utc as f64).abs()
    } else {
        0.0
    };

    let needs_sync = !device_valid || drift_s > DRIFT_THRESHOLD_S;
    if !needs_sync {
        log_info(&format!("Time already in sync (drift={:.1}s)", drift_s));
        return Ok(TimeSyncResult {
            was_in_sync: true,
            drift_s,
            was_invalid: false,
            did_sync: false,
        });
    }

    // Raw JSON: SerialCommand carries a single value.
    let set_time_json = serde_json::json!({
        "cmd": "set_time",
        "utc": utc,
        "offset_min": offset_min,
    })
    .to_string();

    let resp = SerialManager::send_raw_command_safe(
        state.inner(),
        "set_time",
        &set_time_json,
        std::time::Duration::from_secs(3),
    )?;

    match resp {
        DeviceMessage::Ack { .. } => {
            log_info(&format!(
                "Time sync OK (drift={:.1}s, was_invalid={})",
                drift_s, !device_valid
            ));
            Ok(TimeSyncResult {
                was_in_sync: false,
                drift_s,
                was_invalid: !device_valid,
                did_sync: true,
            })
        }
        DeviceMessage::Error { msg, .. } => {
            log_error(&format!("Time sync failed: {}", msg));
            Err(format!("set_time rejected: {}", msg))
        }
        _ => {
            log_error("Time sync: unexpected response");
            Err("Unexpected reply to set_time".to_string())
        }
    }
}

#[tauri::command]
pub fn serial_disconnect(state: State<'_, SharedManager>) -> Result<(), String> {
    let mut mgr = lock_mgr(state.inner())?;
    mgr.disconnect();
    log_info("Disconnect (user)");
    Ok(())
}

/// Coarse range check; the firmware does the real validation.
fn validate_command_value(cmd: &str, value: Option<f64>) -> Result<(), String> {
    let v = match value {
        Some(v) => v,
        None => return Ok(()),
    };

    match cmd {
        "set_freq" => {
            if !(150.0..=960.0).contains(&v) {
                return Err(format!("Frequency out of range (150-960 MHz): {}", v));
            }
        }
        "set_sf" => {
            let sf = v as u8;
            if !SPREADING_FACTORS.contains(&sf) {
                return Err(format!("Invalid SF (6-12): {}", v));
            }
        }
        "set_bw" => {
            if !VALID_BANDWIDTHS.contains(&v) {
                return Err(format!("Invalid bandwidth: {}", v));
            }
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command]
pub fn send_command(
    state: State<'_, SharedManager>,
    cmd: String,
    value: Option<f64>,
) -> Result<serde_json::Value, String> {
    if !VALID_COMMANDS.contains(&cmd.as_str()) {
        return Err(format!("Command not exposed to the frontend: {}", cmd));
    }
    validate_command_value(&cmd, value)?;
    let command = SerialCommand { cmd, value };
    let response = SerialManager::send_command_safe(state.inner(), command)?;
    serde_json::to_value(&response).map_err(|e| format!("Response serialization failed: {}", e))
}

#[tauri::command]
pub fn apply_config(
    state: State<'_, SharedManager>,
    freq: Option<f64>,
    sf: Option<u8>,
    bw: Option<f64>,
) -> Result<LoRaConfig, String> {
    let current = {
        let mgr = lock_mgr(state.inner())?;
        mgr.config.clone().ok_or("No current config")?
    };

    let changes: Vec<SerialCommand> = [
        freq.filter(|v| *v != current.freq).map(|v| SerialCommand {
            cmd: "set_freq".to_string(),
            value: Some(v),
        }),
        sf.filter(|v| *v != current.sf)
            .map(|v| SerialCommand {
                cmd: "set_sf".to_string(),
                value: Some(v as f64),
            }),
        bw.filter(|v| *v != current.bw).map(|v| SerialCommand {
            cmd: "set_bw".to_string(),
            value: Some(v),
        }),
    ]
    .into_iter()
    .flatten()
    .collect();

    if changes.is_empty() {
        return Ok(current);
    }

    // On partial failure, re-read the config so the cache matches the device.
    for cmd in &changes {
        let value_str = cmd.value.map(|v| format!("{}", v)).unwrap_or_default();
        let resp = match SerialManager::send_command_safe(state.inner(), cmd.clone()) {
            Ok(r) => r,
            Err(e) => {
                log_error(&format!("{} {} failed: {}", cmd.cmd, value_str, e));
                let _ = refresh_config_from_device(state.inner());
                return Err(format!("{} error: {}", cmd.cmd, e));
            }
        };
        if let DeviceMessage::Error { msg, .. } = resp {
            log_warn(&format!("{} {} rejected: {}", cmd.cmd, value_str, msg));
            let _ = refresh_config_from_device(state.inner());
            return Err(format!("{} error: {}", cmd.cmd, msg));
        }
        log_info(&format!("{} {} OK", cmd.cmd, value_str));
    }

    let get_cmd = SerialCommand {
        cmd: "get_config".to_string(),
        value: None,
    };
    let resp = SerialManager::send_command_safe(state.inner(), get_cmd)?;

    match resp {
        DeviceMessage::Config {
            freq,
            sf,
            bw,
            drops,
        } => {
            let prev = current.clone();
            let config = LoRaConfig {
                freq: freq.unwrap_or(prev.freq),
                sf: sf.unwrap_or(prev.sf),
                bw: bw.unwrap_or(prev.bw),
                drops: drops.unwrap_or(prev.drops),
            }.sanitized();
            let mut mgr = lock_mgr(state.inner())?;
            mgr.config = Some(config.clone());
            Ok(config)
        }
        _ => Ok(current),
    }
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

fn refresh_config_from_device(state: &SharedManager) {
    if let Ok(DeviceMessage::Config {
        freq,
        sf,
        bw,
        drops,
    }) = SerialManager::send_command_safe(
        state,
        SerialCommand {
            cmd: "get_config".to_string(),
            value: None,
        },
    ) {
        if let Ok(mut mgr) = state.lock() {
            let prev = mgr.config.clone().unwrap_or(LoRaConfig {
                freq: 868.0,
                sf: 7,
                bw: 125.0,
                drops: 0,
            });
            mgr.config = Some(LoRaConfig {
                freq: freq.unwrap_or(prev.freq),
                sf: sf.unwrap_or(prev.sf),
                bw: bw.unwrap_or(prev.bw),
                drops: drops.unwrap_or(prev.drops),
            }.sanitized());
        }
    }
}

#[tauri::command]
pub fn get_config(state: State<'_, SharedManager>) -> Result<Option<LoRaConfig>, String> {
    let mgr = lock_mgr(state.inner())?;
    Ok(mgr.config.clone())
}

#[tauri::command]
pub fn get_frames(state: State<'_, SharedManager>) -> Result<Vec<FrameData>, String> {
    let mgr = lock_mgr(state.inner())?;
    Ok(mgr.frame_store.frames())
}

#[tauri::command]
pub fn get_stats(state: State<'_, SharedManager>) -> Result<FrameStats, String> {
    let mgr = lock_mgr(state.inner())?;
    Ok(mgr.frame_store.stats())
}

#[tauri::command]
pub fn clear_frames(state: State<'_, SharedManager>) -> Result<(), String> {
    let mut mgr = lock_mgr(state.inner())?;
    mgr.frame_store.clear();
    Ok(())
}

#[tauri::command]
pub fn load_capture(
    state: State<'_, SharedManager>,
    config: Option<LoRaConfig>,
    frames: Vec<serde_json::Value>,
) -> Result<Vec<FrameData>, String> {
    let mut mgr = lock_mgr(state.inner())?;

    let frame_data: Vec<FrameData> = frames
        .iter()
        .map(|f| {
            let ts_raw = f.get("timestamp").and_then(|v| v.as_f64()).unwrap_or(0.0);
            // Above 1e12 the timestamp is in ms.
            let timestamp = if ts_raw > 1e12 {
                ts_raw / 1000.0
            } else {
                ts_raw
            };

            FrameData {
                id: Uuid::new_v4().to_string(),
                frame_type: "frame".to_string(),
                hex: f
                    .get("hex")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                timestamp,
                rssi: f.get("rssi").and_then(|v| v.as_f64()),
                snr: f.get("snr").and_then(|v| v.as_f64()),
            }
        })
        .collect();

    mgr.frame_store.load(frame_data.clone());
    mgr.config = config;

    Ok(frame_data)
}

#[tauri::command]
pub fn get_valid_params() -> serde_json::Value {
    serde_json::json!({
        "bandwidths": VALID_BANDWIDTHS,
        "spreadingFactors": SPREADING_FACTORS,
    })
}

// ============================================================
// Firmware update commands
// ============================================================

#[tauri::command]
pub fn get_device_version(
    state: State<'_, SharedManager>,
) -> Result<Option<String>, String> {
    let is_connected = {
        let mgr = lock_mgr(state.inner())?;
        mgr.is_connected()
    };
    if !is_connected {
        return Err("Not connected".to_string());
    }
    let cmd = SerialCommand {
        cmd: "get_version".to_string(),
        value: None,
    };
    match SerialManager::send_command_safe_with_retries(state.inner(), cmd, 1) {
        Ok(DeviceMessage::Ack { version, .. }) => Ok(version),
        _ => Ok(None),
    }
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
    let state_arc = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        flash_firmware_blocking(&state_arc, &firmware_path, &on_progress)
    })
    .await
    .map_err(|e| format!("Flash task panic: {}", e))?
}

fn flash_firmware_blocking(
    state: &SharedManager,
    firmware_path: &str,
    on_progress: &Channel<FlashProgress>,
) -> Result<(), String> {
    use base64::Engine;

    let path = std::path::PathBuf::from(firmware_path);

    // Read firmware binary
    let firmware_data = std::fs::read(&path)
        .map_err(|e| format!("Firmware read failed: {}", e))?;
    let total_size = firmware_data.len() as u64;

    // Compute SHA256
    let sha256 = firmware_manager::compute_sha256(&path)?;

    let timeout_short = std::time::Duration::from_secs(5);
    let timeout_long = std::time::Duration::from_secs(10);

    // Phase 1: ota_begin
    let _ = on_progress.send(FlashProgress {
        status: "starting".to_string(),
        bytes_sent: 0,
        total_bytes: total_size,
        percent: 0.0,
    });

    let begin_json = serde_json::json!({
        "cmd": "ota_begin",
        "size": total_size,
        "sha256": sha256,
    })
    .to_string();

    let resp = SerialManager::send_raw_command_safe_with_retries(
        state,
        "ota_begin",
        &begin_json,
        timeout_long,
        1,
    )?;

    if let DeviceMessage::Error { msg, .. } = resp {
        return Err(format!("ota_begin failed: {}", msg));
    }

    // Phase 2: send chunks
    let chunk_size: usize = 4096;
    let b64_engine = base64::engine::general_purpose::STANDARD;
    let mut bytes_sent: u64 = 0;

    for (seq, chunk) in firmware_data.chunks(chunk_size).enumerate() {
        let b64_data = b64_engine.encode(chunk);

        let data_json = serde_json::json!({
            "cmd": "ota_data",
            "seq": seq,
            "data": b64_data,
        })
        .to_string();

        let resp = SerialManager::send_raw_command_safe(
            state,
            "ota_data",
            &data_json,
            timeout_short,
        )?;

        if let DeviceMessage::Error { msg, .. } = resp {
            return Err(format!("ota_data failed (chunk {}): {}", seq, msg));
        }

        bytes_sent += chunk.len() as u64;
        let percent = (bytes_sent as f64 / total_size as f64) * 100.0;

        let _ = on_progress.send(FlashProgress {
            status: "flashing".to_string(),
            bytes_sent,
            total_bytes: total_size,
            percent,
        });
    }

    // Phase 3: ota_end
    let end_json = r#"{"cmd":"ota_end"}"#;
    let resp = SerialManager::send_raw_command_safe(
        state,
        "ota_end",
        end_json,
        timeout_long,
    )?;

    if let DeviceMessage::Error { msg, .. } = resp {
        return Err(format!("ota_end failed: {}", msg));
    }

    // Phase 4: reboot
    let _ = on_progress.send(FlashProgress {
        status: "rebooting".to_string(),
        bytes_sent: total_size,
        total_bytes: total_size,
        percent: 100.0,
    });

    let reboot_json = r#"{"cmd":"reboot"}"#;
    let _ = SerialManager::send_raw_command_safe(
        state,
        "reboot",
        reboot_json,
        timeout_short,
    );

    let _ = on_progress.send(FlashProgress {
        status: "done".to_string(),
        bytes_sent: total_size,
        total_bytes: total_size,
        percent: 100.0,
    });

    Ok(())
}

/// Reads the device log: ack phase=begin, N event lines, ack phase=end.
/// The collector is cleared on any error so it can't block later commands.
#[tauri::command]
pub fn get_events(state: State<'_, SharedManager>) -> Result<Vec<EventLogEntry>, String> {
    use std::time::Duration;
    const INTER_MSG_TIMEOUT: Duration = Duration::from_secs(5);
    const HARD_CAP_ENTRIES: usize = 5000; // runaway stream guard

    let rx = {
        let mut mgr = lock_mgr(state.inner())?;
        mgr.prepare_events_stream()?
    };

    let mut entries: Vec<EventLogEntry> = Vec::new();
    let mut got_begin = false;

    fn cleanup_collector(state: &SharedManager) {
        if let Ok(mut mgr) = state.lock() {
            mgr.clear_events_collector();
        }
    }

    loop {
        match rx.recv_timeout(INTER_MSG_TIMEOUT) {
            Ok(Ok(DeviceMessage::Ack { cmd, phase, .. })) if cmd == "get_events" => {
                match phase.as_deref() {
                    Some("begin") => {
                        got_begin = true;
                    }
                    Some("end") => {
                        // The dispatcher already cleared the collector.
                        return Ok(entries);
                    }
                    _ => {}
                }
            }
            Ok(Ok(DeviceMessage::Event { line, seq })) => {
                if !got_begin {
                    eprintln!("[get_events] event received before begin ack");
                }
                entries.push(EventLogEntry {
                    line,
                    seq: seq.unwrap_or(entries.len() as u32),
                });
                if entries.len() >= HARD_CAP_ENTRIES {
                    cleanup_collector(state.inner());
                    return Err(format!(
                        "Stream too long ({} events), firmware fault?",
                        HARD_CAP_ENTRIES
                    ));
                }
            }
            Ok(Ok(DeviceMessage::Error { msg, .. })) => {
                cleanup_collector(state.inner());
                return Err(format!("Device rejected get_events: {}", msg));
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                cleanup_collector(state.inner());
                return Err(format!("Stream interrupted: {}", e));
            }
            Err(_) => {
                cleanup_collector(state.inner());
                return Err(format!(
                    "Event stream timeout (nothing received for {}s)",
                    INTER_MSG_TIMEOUT.as_secs()
                ));
            }
        }
    }
}
