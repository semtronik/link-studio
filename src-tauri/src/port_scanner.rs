//! Background serial port scanner, the single source of truth for the port list.
//! Probes Espressif ports with `get_version` and emits `ports_changed` on change.

use crate::lora_protocol::{
    DeviceMessage, DeviceKind, PortFirmwareInfo, PortInfo,
};
use crate::serial_manager::SerialManager;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const EVENT_PORTS_CHANGED: &str = "ports_changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanPace {
    Active,
    Idle,
}

impl ScanPace {
    fn interval(self) -> Duration {
        match self {
            ScanPace::Active => Duration::from_millis(2000),
            ScanPace::Idle => Duration::from_millis(5000),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortsChangedEvent {
    pub ports: Vec<PortInfo>,
    pub scanning: bool,
}

pub struct ScannerState {
    pace: ScanPace,
    last_ports: Vec<PortInfo>,
    force_refresh: bool,
    /// Port currently open for a probe; `ConnectingGuard` waits on it
    /// (concurrent opens fail with os error 121 on Windows).
    probing_path: Option<String>,
}

impl ScannerState {
    fn new() -> Self {
        Self {
            pace: ScanPace::Idle,
            last_ports: Vec::new(),
            force_refresh: false,
            probing_path: None,
        }
    }
}

pub struct PortScanner {
    state: Arc<(Mutex<ScannerState>, Condvar)>,
}

impl PortScanner {
    pub fn new() -> Self {
        Self {
            state: Arc::new((Mutex::new(ScannerState::new()), Condvar::new())),
        }
    }

    pub fn current_ports(&self) -> Vec<PortInfo> {
        let (lock, _) = &*self.state;
        let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        guard.last_ports.clone()
    }

    pub fn set_pace(&self, pace: ScanPace) {
        let (lock, cvar) = &*self.state;
        let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        guard.pace = pace;
        cvar.notify_all();
    }

    pub fn trigger_refresh(&self) {
        let (lock, cvar) = &*self.state;
        let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        guard.force_refresh = true;
        cvar.notify_all();
    }

    /// Waits up to `max` for any probe on `path` to end. Returns whether it waited.
    pub fn wait_probe_clear(&self, path: &str, max: Duration) -> bool {
        let (lock, _) = &*self.state;
        let deadline = Instant::now() + max;
        let mut waited = false;
        loop {
            {
                let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
                if guard.probing_path.as_deref() != Some(path) {
                    return waited;
                }
            }
            if Instant::now() >= deadline {
                return waited;
            }
            waited = true;
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn spawn_loop(
        &self,
        app: AppHandle,
        serial: Arc<Mutex<SerialManager>>,
    ) {
        let state = self.state.clone();
        std::thread::Builder::new()
            .name("port-scanner".to_string())
            .spawn(move || run_loop(state, app, serial))
            .expect("port-scanner thread spawn failed");
    }
}

fn run_loop(
    state: Arc<(Mutex<ScannerState>, Condvar)>,
    app: AppHandle,
    serial: Arc<Mutex<SerialManager>>,
) {
    let mut probe_cache: HashMap<String, ProbeCacheEntry> = HashMap::new();
    let (lock, cvar) = &*state;

    loop {
        let pace = {
            let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
            guard.pace
        };

        let (new_ports, has_identifying) = scan_once(&mut probe_cache, &serial, &state);

        let changed = {
            let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
            let changed = !ports_equal(&guard.last_ports, &new_ports);
            if changed {
                guard.last_ports = new_ports.clone();
            }
            changed
        };

        if changed {
            let _ = app.emit(
                EVENT_PORTS_CHANGED,
                PortsChangedEvent {
                    ports: new_ports,
                    scanning: has_identifying,
                },
            );
        }

        // Tick faster while a port is still identifying, to catch the end of its boot.
        let interval = if has_identifying {
            IDENTIFYING_TICK
        } else {
            pace.interval()
        };

        let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        let wait_res = cvar.wait_timeout_while(guard, interval, |s| {
            !s.force_refresh && s.pace == pace
        });
        if let Ok((mut s, _)) = wait_res {
            s.force_refresh = false;
        }
    }
}

/// Fills firmware info from `Success` cache entries only, without opening any port.
fn enrich_from_cache_only(
    ports: Vec<PortInfo>,
    cache: &HashMap<String, ProbeCacheEntry>,
) -> Vec<PortInfo> {
    ports
        .into_iter()
        .map(|mut port| {
            if let Some(ProbeCacheEntry::Success(info)) = cache.get(&cache_key(&port)) {
                port.firmware = Some(info.clone());
            }
            port
        })
        .collect()
}

fn scan_once(
    cache: &mut HashMap<String, ProbeCacheEntry>,
    serial: &Arc<Mutex<SerialManager>>,
    state: &Arc<(Mutex<ScannerState>, Condvar)>,
) -> (Vec<PortInfo>, bool) {
    let ports = match list_ports_filtered() {
        Ok(p) => p,
        Err(e) => {
            crate::log_warn(&format!("port_scanner: enumeration failed: {}", e));
            return (Vec::new(), false);
        }
    };

    // Forget unplugged ports: a replugged device reboots and must be re-probed,
    // or the stale cache would offer a device not ready to connect yet.
    {
        let present: std::collections::HashSet<String> =
            ports.iter().map(cache_key).collect();
        cache.retain(|k, _| present.contains(k));
    }

    // No probing during a session: opening ports collides with other tools
    // (esptool flashing a second ESP gets os error 121 on both sides).
    let connected = {
        let guard = serial.lock().unwrap_or_else(|p| p.into_inner());
        guard.busy_path().is_some()
    };
    if connected {
        return (enrich_from_cache_only(ports, cache), false);
    }

    let mut enriched = Vec::with_capacity(ports.len());
    let mut has_identifying = false;
    let now = Instant::now();

    for mut port in ports {
        if !is_candidate_vid(&port.vid) {
            enriched.push(port);
            continue;
        }

        let key = cache_key(&port);

        match cache.get(&key).cloned() {
            Some(ProbeCacheEntry::Success(info)) => {
                port.firmware = Some(info);
                enriched.push(port);
                continue;
            }
            Some(ProbeCacheEntry::Retrying { last_attempt, .. })
                if now.duration_since(last_attempt) < PROBE_RETRY_DELAY =>
            {
                port.identifying = true;
                has_identifying = true;
                enriched.push(port);
                continue;
            }
            Some(ProbeCacheEntry::Failure { until, reason }) if until > now => {
                if reason == FailureReason::Busy {
                    port.busy = true;
                }
                enriched.push(port);
                continue;
            }
            Some(ProbeCacheEntry::Failure { .. }) => {
                cache.remove(&key);
            }
            _ => {}
        }

        let busy_now = {
            let guard = serial.lock().unwrap_or_else(|p| p.into_inner());
            guard.busy_path().map(|s| s.to_string())
        };
        if busy_now.as_deref() == Some(port.path.as_str()) {
            enriched.push(port);
            continue;
        }

        {
            let (lock, _) = &**state;
            let mut g = lock.lock().unwrap_or_else(|p| p.into_inner());
            g.probing_path = Some(port.path.clone());
        }

        let outcome = probe_port_firmware(&port.path);

        {
            let (lock, cvar) = &**state;
            let mut g = lock.lock().unwrap_or_else(|p| p.into_inner());
            g.probing_path = None;
            cvar.notify_all();
        }

        match outcome {
            ProbeOutcome::Identified(info) => {
                crate::log_info(&format!(
                    "port_scanner: {} identified: {:?} v{}",
                    port.path,
                    info.kind,
                    info.version.as_deref().unwrap_or("?")
                ));
                cache.insert(key, ProbeCacheEntry::Success(info.clone()));
                port.firmware = Some(info);
            }
            ProbeOutcome::OpenFailed => {
                crate::log_warn(&format!(
                    "port_scanner: {} open failed (busy?), cached Failure {}s",
                    port.path,
                    PROBE_FAILURE_TTL.as_secs()
                ));
                cache.insert(
                    key,
                    ProbeCacheEntry::Failure {
                        until: now + PROBE_FAILURE_TTL,
                        reason: FailureReason::Busy,
                    },
                );
                port.busy = true;
            }
            ProbeOutcome::NoResponse => {
                // Device still booting after hot-plug.
                let prev_attempts = match cache.get(&key) {
                    Some(ProbeCacheEntry::Retrying { attempts, .. }) => *attempts,
                    _ => 0,
                };
                let attempts = prev_attempts + 1;
                if attempts >= PROBE_MAX_ATTEMPTS {
                    crate::log_warn(&format!(
                        "port_scanner: {} silent after {} attempts, cached Failure {}s",
                        port.path,
                        attempts,
                        PROBE_FAILURE_TTL.as_secs()
                    ));
                    cache.insert(
                        key,
                        ProbeCacheEntry::Failure {
                            until: now + PROBE_FAILURE_TTL,
                            reason: FailureReason::Unresponsive,
                        },
                    );
                } else {
                    crate::log_debug(&format!(
                        "port_scanner: {} no response (attempt {}/{}), retry in {}ms",
                        port.path,
                        attempts,
                        PROBE_MAX_ATTEMPTS,
                        PROBE_RETRY_DELAY.as_millis()
                    ));
                    cache.insert(
                        key,
                        ProbeCacheEntry::Retrying {
                            attempts,
                            last_attempt: now,
                        },
                    );
                    port.identifying = true;
                    has_identifying = true;
                }
            }
        }

        enriched.push(port);
    }

    (enriched, has_identifying)
}

/// Compares only what the UI shows; other USB fields can be reformatted by the OS.
fn ports_equal(a: &[PortInfo], b: &[PortInfo]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).all(|(x, y)| {
        x.path == y.path
            && x.identifying == y.identifying
            && x.busy == y.busy
            && firmware_eq(x.firmware.as_ref(), y.firmware.as_ref())
    })
}

fn firmware_eq(a: Option<&PortFirmwareInfo>, b: Option<&PortFirmwareInfo>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => {
            x.kind == y.kind
                && x.product == y.product
                && x.model == y.model
                && x.version == y.version
        }
        _ => false,
    }
}

// ============================================================
// Enumeration and filtering
// ============================================================

fn list_ports_filtered() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports()
        .map_err(|e| format!("Port enumeration failed: {}", e))?;

    let mut result: Vec<PortInfo> = ports
        .iter()
        .map(port_to_info)
        .filter(|p| is_displayable_vid(&p.vid))
        .collect();

    result.sort_by_key(|p| (port_sort_key(&p.path), p.path.clone()));
    Ok(result)
}

fn port_to_info(p: &serialport::SerialPortInfo) -> PortInfo {
    let (manufacturer, product, vid, pid, serial_number) = match &p.port_type {
        serialport::SerialPortType::UsbPort(usb) => (
            usb.manufacturer.clone().unwrap_or_default(),
            usb.product.clone().unwrap_or_default(),
            format!("{:04X}", usb.vid),
            format!("{:04X}", usb.pid),
            usb.serial_number.clone().unwrap_or_default(),
        ),
        _ => (String::new(), String::new(), String::new(), String::new(), String::new()),
    };
    let port_type = match &p.port_type {
        serialport::SerialPortType::UsbPort(_) => "USB".to_string(),
        serialport::SerialPortType::PciPort => "PCI".to_string(),
        serialport::SerialPortType::BluetoothPort => "Bluetooth".to_string(),
        serialport::SerialPortType::Unknown => String::new(),
    };
    PortInfo {
        path: p.port_name.clone(),
        manufacturer,
        product,
        vid,
        pid,
        serial_number,
        port_type,
        firmware: None,
        identifying: false,
        busy: false,
    }
}

/// Only Espressif ports are probed.
fn is_candidate_vid(vid: &str) -> bool {
    vid.eq_ignore_ascii_case("303A")
}

/// Known USB-serial bridges shown in the list.
fn is_displayable_vid(vid: &str) -> bool {
    matches!(
        vid.to_uppercase().as_str(),
        "303A" | "10C4" | "1A86" | "0403"
    )
}

fn port_sort_key(path: &str) -> u32 {
    if let Some(num_str) = path.strip_prefix("COM") {
        num_str.parse::<u32>().unwrap_or(u32::MAX)
    } else {
        u32::MAX
    }
}

// ============================================================
// Probe cache
// ============================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FailureReason {
    /// Held by another application.
    Busy,
    /// No reply after `PROBE_MAX_ATTEMPTS`; probably not a Link-LR.
    Unresponsive,
}

#[derive(Clone)]
enum ProbeCacheEntry {
    /// Kept until the port is unplugged.
    Success(PortFirmwareInfo),
    Retrying { attempts: u32, last_attempt: Instant },
    Failure { until: Instant, reason: FailureReason },
}

const PROBE_FAILURE_TTL: Duration = Duration::from_secs(15);

/// A ready device answers in a few ms; retries cover the boot after hot-plug.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// ~40 s of retries, well past the device's boot time.
const PROBE_MAX_ATTEMPTS: u32 = 15;

const PROBE_RETRY_DELAY: Duration = Duration::from_millis(500);

const IDENTIFYING_TICK: Duration = Duration::from_millis(500);

#[derive(Debug)]
enum ProbeOutcome {
    Identified(PortFirmwareInfo),
    OpenFailed,
    NoResponse,
}

fn cache_key(port: &PortInfo) -> String {
    format!("{}:{}:{}", port.vid, port.pid, port.serial_number)
}

fn probe_port_firmware(port_name: &str) -> ProbeOutcome {
    let t0 = Instant::now();

    let mut port = match serialport::new(port_name, 115200)
        .timeout(Duration::from_millis(200))
        .open()
    {
        Ok(p) => p,
        Err(e) => {
            crate::log_debug(&format!(
                "probe {} open failed: {} ({}ms)",
                port_name,
                e.description,
                t0.elapsed().as_millis()
            ));
            return ProbeOutcome::OpenFailed;
        }
    };

    let _ = port.write_data_terminal_ready(false);
    let _ = port.write_request_to_send(false);
    let _ = port.clear(serialport::ClearBuffer::All);

    let cmd = r#"{"cmd":"get_version"}"#;
    if let Err(e) = port.write_all(format!("{}\n", cmd).as_bytes()) {
        crate::log_debug(&format!(
            "probe {} write failed: {} ({}ms)",
            port_name,
            e,
            t0.elapsed().as_millis()
        ));
        return ProbeOutcome::NoResponse;
    }
    let _ = port.flush();

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut reader = BufReader::new(&mut port);
    let mut lines_seen = 0u32;

    while Instant::now() < deadline {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(n) if n > 0 => {
                lines_seen += 1;
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(DeviceMessage::Ack {
                    cmd: ref c,
                    ref product,
                    ref model,
                    ref version,
                    ref mac,
                    ..
                }) = serde_json::from_str::<DeviceMessage>(trimmed)
                {
                    if c == "get_version" {
                        let kind = DeviceKind::from_version_ack(
                            product.as_deref(),
                            model.as_deref(),
                        );
                        crate::log_debug(&format!(
                            "probe {} identified in {}ms ({} line(s) seen)",
                            port_name,
                            t0.elapsed().as_millis(),
                            lines_seen
                        ));
                        return ProbeOutcome::Identified(PortFirmwareInfo {
                            kind,
                            product: product.clone(),
                            model: model.clone(),
                            version: version.clone(),
                            mac: mac.clone(),
                        });
                    }
                }
            }
            Ok(_) => break,
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(_) => break,
        }
    }

    crate::log_debug(&format!(
        "probe {} no ack after {}ms ({} line(s) seen)",
        port_name,
        t0.elapsed().as_millis(),
        lines_seen
    ));
    ProbeOutcome::NoResponse
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_port() -> PortInfo {
        PortInfo {
            path: "COM3".into(),
            manufacturer: "x".into(),
            product: "y".into(),
            vid: "303A".into(),
            pid: "0001".into(),
            serial_number: "42".into(),
            port_type: "USB".into(),
            firmware: None,
            identifying: false,
        busy: false,
        }
    }

    #[test]
    fn ports_equal_detects_firmware_change() {
        let a = make_port();
        let mut b = a.clone();
        b.firmware = Some(PortFirmwareInfo {
            kind: DeviceKind::LinkLr,
            product: Some("Link".into()),
            model: Some("Link-LR".into()),
            version: Some("0.2.3".into()),
            mac: None,
        });
        assert!(!ports_equal(&[a.clone()], &[b.clone()]));
        assert!(ports_equal(&[a.clone()], &[a.clone()]));
        assert!(ports_equal(&[b.clone()], &[b.clone()]));
    }

    #[test]
    fn ports_equal_ignores_product_label() {
        let a = make_port();
        let mut b = a.clone();
        b.product = "P2".into();
        assert!(ports_equal(&[a], &[b]));
    }

    #[test]
    fn ports_equal_detects_identifying_change() {
        let a = make_port();
        let mut b = a.clone();
        b.identifying = true;
        assert!(!ports_equal(&[a], &[b]));
    }

    #[test]
    fn ports_equal_detects_busy_change() {
        let a = make_port();
        let mut b = a.clone();
        b.busy = true;
        assert!(!ports_equal(&[a], &[b]));
    }

    #[test]
    fn pace_interval_values() {
        assert_eq!(ScanPace::Active.interval(), Duration::from_millis(2000));
        assert_eq!(ScanPace::Idle.interval(), Duration::from_millis(5000));
    }

    #[test]
    fn enrich_from_cache_reuses_success_without_probe() {
        let port = make_port();
        let info = PortFirmwareInfo {
            kind: DeviceKind::LinkLr,
            product: Some("Link".into()),
            model: Some("Link-LR".into()),
            version: Some("0.2.3".into()),
            mac: None,
        };
        let mut cache = HashMap::new();
        cache.insert(cache_key(&port), ProbeCacheEntry::Success(info.clone()));

        let out = enrich_from_cache_only(vec![port], &cache);
        assert_eq!(out.len(), 1);
        assert!(firmware_eq(out[0].firmware.as_ref(), Some(&info)));
    }

    #[test]
    fn enrich_from_cache_leaves_unknown_ports_untouched() {
        let port = make_port();
        let cache = HashMap::new();
        let out = enrich_from_cache_only(vec![port.clone()], &cache);
        assert_eq!(out.len(), 1);
        assert!(out[0].firmware.is_none());
        assert_eq!(out[0].path, port.path);
    }

    #[test]
    fn busy_path_drives_freeze_decision() {
        let mut mgr = SerialManager::new();
        assert!(mgr.busy_path().is_none());
        mgr.begin_connecting("COM3");
        assert_eq!(mgr.busy_path(), Some("COM3"));
        mgr.end_connecting();
        assert!(mgr.busy_path().is_none());
    }

    #[test]
    fn vid_filters() {
        assert!(is_candidate_vid("303A"));
        assert!(is_candidate_vid("303a"));
        assert!(!is_candidate_vid("10C4"));

        assert!(is_displayable_vid("303A"));
        assert!(is_displayable_vid("10C4"));
        assert!(is_displayable_vid("1A86"));
        assert!(is_displayable_vid("0403"));
        assert!(!is_displayable_vid("DEAD"));
    }
}
