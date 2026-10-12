use crate::frame_store::FrameStore;
use crate::lora_protocol::*;
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::ipc::Channel;
use uuid::Uuid;

const MAX_LINE_LEN: usize = 8192;

/// Recovers from a poisoned mutex: state may be inconsistent, but the app keeps running.
fn lock_or_recover(state: &Arc<Mutex<SerialManager>>) -> std::sync::MutexGuard<'_, SerialManager> {
    state.lock().unwrap_or_else(|poisoned| {
        eprintln!("[serial_manager] Mutex poisoned, recovering state");
        poisoned.into_inner()
    })
}

/// Serialized as `{ "code": "port_busy", "port": ..., "raw": ... }`; the
/// frontend maps `code` to a message.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ConnectError {
    PortBusy { port: String, raw: String },
    PortNotFound { port: String, raw: String },
    PermissionDenied { port: String, raw: String },
    InvalidSettings { port: String, raw: String },
    Other { port: String, raw: String },
    UnsupportedDevice { port: String, raw: String, kind: DeviceKind },
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::PortBusy { port, raw } => write!(f, "port_busy({}): {}", port, raw),
            ConnectError::PortNotFound { port, raw } => write!(f, "port_not_found({}): {}", port, raw),
            ConnectError::PermissionDenied { port, raw } => write!(f, "permission_denied({}): {}", port, raw),
            ConnectError::InvalidSettings { port, raw } => write!(f, "invalid_settings({}): {}", port, raw),
            ConnectError::Other { port, raw } => write!(f, "other({}): {}", port, raw),
            ConnectError::UnsupportedDevice { port, raw, .. } => write!(f, "unsupported_device({}): {}", port, raw),
        }
    }
}

/// Classifies by OS error code (not localized), then by `ErrorKind`.
/// Access denied means busy on Windows, a missing dialout group on Unix.
pub fn classify_open_error(port_name: &str, e: &serialport::Error) -> ConnectError {
    use serialport::ErrorKind;

    crate::log_warn(&format!(
        "open {} failed: kind={:?} description={:?}",
        port_name, e.kind, e.description
    ));

    let raw = e.description.clone();
    let port = port_name.to_string();

    // NoDevice is ambiguous on Windows (absent or busy), so get the OS code first.
    let os_code = extract_raw_os_error(e).or_else(|| probe_os_error(port_name));

    crate::log_warn(&format!("open {} resolved os_code={:?}", port_name, os_code));

    if let Some(code) = os_code {
        if is_busy_code(code) {
            return ConnectError::PortBusy { port, raw };
        }
        if is_not_found_code(code) {
            return ConnectError::PortNotFound { port, raw };
        }
        if is_permission_code(code) {
            return classify_permission_or_busy(port, raw);
        }
    }

    match e.kind {
        ErrorKind::NoDevice => ConnectError::PortNotFound { port, raw },
        ErrorKind::InvalidInput => ConnectError::InvalidSettings { port, raw },
        ErrorKind::Io(_) | ErrorKind::Unknown => ConnectError::Other { port, raw },
    }
}

/// Parses "os error N"; serialport often drops the code on Windows.
fn extract_raw_os_error(e: &serialport::Error) -> Option<i32> {
    let desc = &e.description;
    let idx = desc.find("os error ")?;
    let rest = &desc[idx + "os error ".len()..];
    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse::<i32>().ok()
}

/// Reopens the port with std to get the OS error code. Runs on a thread with
/// a 500 ms timeout: some drivers block on open.
fn probe_os_error(port_name: &str) -> Option<i32> {
    let port_owned = port_name.to_string();

    let (tx, rx) = std::sync::mpsc::channel::<Option<i32>>();
    std::thread::spawn(move || {
        let result = probe_os_error_blocking(&port_owned);
        let _ = tx.send(result);
    });

    match rx.recv_timeout(std::time::Duration::from_millis(500)) {
        Ok(code) => code,
        Err(_) => {
            crate::log_warn(&format!(
                "probe_os_error timeout for {} — falling back to ErrorKind",
                port_name
            ));
            None
        }
    }
}

fn probe_os_error_blocking(port_name: &str) -> Option<i32> {
    use std::fs::OpenOptions;

    let path = if cfg!(target_os = "windows") {
        // The \\.\ prefix is required for COM10+.
        format!(r"\\.\{}", port_name)
    } else {
        port_name.to_string()
    };

    let mut opts = OpenOptions::new();
    opts.read(true).write(true);

    // O_NONBLOCK: some macOS USB-serial drivers block on open waiting for DCD.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        const O_NONBLOCK: i32 = if cfg!(target_os = "macos") { 0x0004 } else { 0x0800 };
        opts.custom_flags(O_NONBLOCK);
    }

    let result = opts.open(&path);
    match result {
        Ok(_handle) => None,
        Err(io_err) => io_err.raw_os_error(),
    }
}

fn is_busy_code(code: i32) -> bool {
    if cfg!(target_os = "windows") {
        // ERROR_ACCESS_DENIED = 5, ERROR_SHARING_VIOLATION = 32
        code == 5 || code == 32
    } else {
        // EBUSY = 16
        code == 16
    }
}

fn is_not_found_code(code: i32) -> bool {
    if cfg!(target_os = "windows") {
        // ERROR_FILE_NOT_FOUND = 2
        code == 2
    } else {
        // ENOENT = 2, ENXIO = 6, ENODEV = 19
        code == 2 || code == 6 || code == 19
    }
}

fn is_permission_code(code: i32) -> bool {
    if cfg!(target_os = "windows") {
        false // access denied (5) is treated as busy on Windows
    } else {
        // EACCES = 13, EPERM = 1
        code == 13 || code == 1
    }
}

fn classify_permission_or_busy(port: String, raw: String) -> ConnectError {
    if cfg!(target_os = "windows") {
        ConnectError::PortBusy { port, raw }
    } else {
        ConnectError::PermissionDenied { port, raw }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_codes_per_os() {
        if cfg!(target_os = "windows") {
            assert!(is_busy_code(5),  "Windows ERROR_ACCESS_DENIED");
            assert!(is_busy_code(32), "Windows ERROR_SHARING_VIOLATION");
            assert!(!is_busy_code(2));
            assert!(!is_busy_code(13));
        } else {
            assert!(is_busy_code(16), "Unix EBUSY");
            assert!(!is_busy_code(13), "EACCES is not busy on Unix");
            assert!(!is_busy_code(2));
            assert!(!is_busy_code(5));
        }
    }

    #[test]
    fn not_found_codes_per_os() {
        if cfg!(target_os = "windows") {
            assert!(is_not_found_code(2), "Windows ERROR_FILE_NOT_FOUND");
            assert!(!is_not_found_code(5));
            assert!(!is_not_found_code(19));
        } else {
            assert!(is_not_found_code(2),  "Unix ENOENT");
            assert!(is_not_found_code(6),  "Unix ENXIO");
            assert!(is_not_found_code(19), "Unix ENODEV");
            assert!(!is_not_found_code(13));
        }
    }

    #[test]
    fn permission_codes_per_os() {
        if cfg!(target_os = "windows") {
            assert!(!is_permission_code(5));
            assert!(!is_permission_code(13));
        } else {
            assert!(is_permission_code(13), "Unix EACCES");
            assert!(is_permission_code(1),  "Unix EPERM");
            assert!(!is_permission_code(2));
            assert!(!is_permission_code(16));
        }
    }

    #[test]
    fn classify_permission_or_busy_windows_is_busy() {
        let result = classify_permission_or_busy("COM3".into(), "raw".into());
        if cfg!(target_os = "windows") {
            assert!(matches!(result, ConnectError::PortBusy { .. }));
        } else {
            assert!(matches!(result, ConnectError::PermissionDenied { .. }));
        }
    }

    #[test]
    fn extract_raw_os_error_parses_standard_format() {
        let e = serialport::Error {
            kind: serialport::ErrorKind::Io(std::io::ErrorKind::Other),
            description: "operation failed (os error 5)".to_string(),
        };
        assert_eq!(extract_raw_os_error(&e), Some(5));
    }

    #[test]
    fn extract_raw_os_error_returns_none_when_no_marker() {
        let e = serialport::Error {
            kind: serialport::ErrorKind::NoDevice,
            description: "Access is denied.".to_string(),
        };
        assert_eq!(extract_raw_os_error(&e), None);
    }

    #[test]
    fn connect_error_serializes_with_code_field() {
        let e = ConnectError::PortBusy {
            port: "COM3".into(),
            raw: "Access is denied.".into(),
        };
        let json = serde_json::to_string(&e).unwrap();
        // Frontend contract.
        assert!(json.contains(r#""code":"port_busy""#));
        assert!(json.contains(r#""port":"COM3""#));
        assert!(json.contains(r#""raw":"Access is denied.""#));
    }
}

pub struct SerialManager {
    port: Option<Box<dyn serialport::SerialPort>>,
    connected_path: Option<String>,
    connecting_path: Option<String>,
    stop_tx: Option<mpsc::Sender<()>>,
    reader_handle: Option<JoinHandle<()>>,
    pub frame_store: FrameStore,
    pub config: Option<LoRaConfig>,
    cmd_queue: VecDeque<(u64, String, mpsc::Sender<Result<DeviceMessage, String>>)>,
    next_cmd_id: u64,
    /// While Some, get_events acks and event lines go here instead of cmd_queue.
    events_collector: Option<mpsc::Sender<Result<DeviceMessage, String>>>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            port: None,
            connected_path: None,
            connecting_path: None,
            stop_tx: None,
            reader_handle: None,
            frame_store: FrameStore::new(),
            config: None,
            cmd_queue: VecDeque::new(),
            next_cmd_id: 0,
            events_collector: None,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.port.is_some()
    }

    pub fn begin_connecting(&mut self, port_name: &str) {
        self.connecting_path = Some(port_name.to_string());
    }

    pub fn end_connecting(&mut self) {
        self.connecting_path = None;
    }

    /// Connected or connecting port; the scanner leaves it alone.
    pub fn busy_path(&self) -> Option<&str> {
        self.connected_path
            .as_deref()
            .or(self.connecting_path.as_deref())
    }

    /// Called with the lock held: `state` is for the reader thread only, never
    /// lock it here (deadlock).
    pub fn connect(
        &mut self,
        port_name: &str,
        baud_rate: u32,
        channel: Channel<SerialEvent>,
        state: Arc<Mutex<SerialManager>>,
    ) -> Result<(), ConnectError> {
        if self.port.is_some() {
            return Err(ConnectError::Other {
                port: port_name.to_string(),
                raw: "already_connected".to_string(),
            });
        }

        let mut port = serialport::new(port_name, baud_rate)
            .timeout(std::time::Duration::from_millis(10))
            .open()
            .map_err(|e| classify_open_error(port_name, &e))?;

        // Deassert DTR/RTS first: a pulse can reset an ESP32 board.
        let _ = port.write_data_terminal_ready(false);
        let _ = port.write_request_to_send(false);

        // Drop firmware boot logs.
        let _ = port.clear(serialport::ClearBuffer::Input);

        let reader_port = port.try_clone().map_err(|e| ConnectError::Other {
            port: port_name.to_string(),
            raw: format!("clone_failed: {}", e),
        })?;

        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        self.port = Some(port);
        self.connected_path = Some(port_name.to_string());
        self.stop_tx = Some(stop_tx);

        let handle = std::thread::spawn(move || {
            let mut reader = BufReader::new(reader_port);
            let mut line_buf = String::new();

            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }

                line_buf.clear();
                match reader.read_line(&mut line_buf) {
                    Ok(0) => {
                        crate::log_warn("Disconnect (EOF on serial read)");
                        let _ = channel.send(SerialEvent::Disconnected);
                        let mut mgr = lock_or_recover(&state);
                        mgr.cleanup();
                        break;
                    }
                    Ok(_) => {
                        if line_buf.len() > MAX_LINE_LEN {
                            line_buf.clear();
                            continue;
                        }

                        let trimmed = line_buf.trim();
                        if trimmed.is_empty() {
                            continue;
                        }

                        // Parse outside the lock.
                        let parsed = serde_json::from_str::<DeviceMessage>(trimmed);

                        if let Ok(msg) = parsed {
                            let mut mgr = lock_or_recover(&state);
                            mgr.dispatch(msg, &channel);
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                        continue;
                    }
                    Err(e) => {
                        crate::log_warn(&format!("Disconnect (serial read error: {})", e));
                        let _ = channel.send(SerialEvent::Disconnected);
                        let mut mgr = lock_or_recover(&state);
                        mgr.cleanup();
                        break;
                    }
                }
            }
        });

        self.reader_handle = Some(handle);

        Ok(())
    }

    fn dispatch(&mut self, msg: DeviceMessage, channel: &Channel<SerialEvent>) {
        fn now_secs() -> f64 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs_f64()
        }

        /// Above 1e12 the timestamp is in ms.
        fn normalize_ts(ts: f64) -> f64 {
            if ts > 1e12 { ts / 1000.0 } else { ts }
        }

        match msg {
            DeviceMessage::Packet {
                ts,
                rssi,
                snr,
                data,
                ..
            } => {
                let timestamp = ts.map(normalize_ts).unwrap_or_else(now_secs);
                let frame = FrameData {
                    id: Uuid::new_v4().to_string(),
                    frame_type: "frame".to_string(),
                    hex: data.unwrap_or_default(),
                    timestamp,
                    rssi,
                    snr,
                };
                self.frame_store.push(frame.clone());
                let _ = channel.send(SerialEvent::Frame(frame));
                let _ = channel.send(SerialEvent::Stats(self.frame_store.stats()));
            }
            DeviceMessage::Frame {
                ts,
                timestamp,
                rssi,
                snr,
                hex,
                data,
                ..
            } => {
                let ts_val = ts.or(timestamp).map(normalize_ts).unwrap_or_else(now_secs);
                let frame = FrameData {
                    id: Uuid::new_v4().to_string(),
                    frame_type: "frame".to_string(),
                    hex: hex.or(data).unwrap_or_default(),
                    timestamp: ts_val,
                    rssi,
                    snr,
                };
                self.frame_store.push(frame.clone());
                let _ = channel.send(SerialEvent::Frame(frame));
                let _ = channel.send(SerialEvent::Stats(self.frame_store.stats()));
            }
            DeviceMessage::Config {
                freq,
                sf,
                bw,
                drops,
            } => {
                let prev = self.config.clone().unwrap_or(LoRaConfig {
                    freq: 868.0,
                    sf: 7,
                    bw: 125.0,
                    drops: 0,
                });
                let config = LoRaConfig {
                    freq: freq.unwrap_or(prev.freq),
                    sf: sf.unwrap_or(prev.sf),
                    bw: bw.unwrap_or(prev.bw),
                    drops: drops.unwrap_or(prev.drops),
                }.sanitized();
                self.config = Some(config.clone());
                let _ = channel.send(SerialEvent::Config(config));

                if let Some((_, expected_cmd, _)) = self.cmd_queue.front() {
                    if expected_cmd == "get_config" {
                        let (_, _, tx) = self.cmd_queue.pop_front().unwrap();
                        let _ = tx.send(Ok(DeviceMessage::Config {
                            freq,
                            sf,
                            bw,
                            drops,
                        }));
                    }
                }
            }
            DeviceMessage::Ack { ref cmd, ref phase, .. } => {
                if cmd == "get_events" && self.events_collector.is_some() {
                    if let Some(tx) = self.events_collector.as_ref() {
                        let _ = tx.send(Ok(msg.clone()));
                    }
                    if phase.as_deref() == Some("end") {
                        self.events_collector = None;
                    }
                    return;
                }

                // Matching by name is enough: commands are sent one at a time.
                if let Some((_, expected_cmd, _)) = self.cmd_queue.front() {
                    if expected_cmd == cmd {
                        let (_, _, tx) = self.cmd_queue.pop_front().unwrap();
                        let _ = tx.send(Ok(msg.clone()));
                    }
                }
            }
            DeviceMessage::Error { ref cmd, .. } => {
                if cmd == "get_events" && self.events_collector.is_some() {
                    if let Some(tx) = self.events_collector.as_ref() {
                        let _ = tx.send(Ok(msg.clone()));
                    }
                    self.events_collector = None;
                    return;
                }

                if let Some((_, expected_cmd, _)) = self.cmd_queue.front() {
                    if expected_cmd == cmd {
                        let (_, _, tx) = self.cmd_queue.pop_front().unwrap();
                        let _ = tx.send(Ok(msg.clone()));
                    }
                }
            }
            DeviceMessage::Event { .. } => {
                if let Some(tx) = self.events_collector.as_ref() {
                    let _ = tx.send(Ok(msg.clone()));
                }
            }
            DeviceMessage::Time { .. } => {
                if let Some((_, expected_cmd, _)) = self.cmd_queue.front() {
                    if expected_cmd == "get_time" {
                        let (_, _, tx) = self.cmd_queue.pop_front().unwrap();
                        let _ = tx.send(Ok(msg.clone()));
                    }
                }
            }
        }
    }

    /// The caller must release the lock before waiting on the receiver.
    pub fn prepare_command(
        &mut self,
        cmd: SerialCommand,
    ) -> Result<(u64, mpsc::Receiver<Result<DeviceMessage, String>>), String> {
        if !INTERNAL_COMMANDS.contains(&cmd.cmd.as_str()) {
            return Err(format!("Unknown command: {}", cmd.cmd));
        }

        let port = self.port.as_mut().ok_or("Not connected")?;

        let cmd_id = self.next_cmd_id;
        self.next_cmd_id += 1;

        let (tx, rx) = mpsc::channel();
        self.cmd_queue.push_back((cmd_id, cmd.cmd.clone(), tx));

        let json =
            serde_json::to_string(&cmd).map_err(|e| format!("Serialization failed: {}", e))?;

        port.write_all(format!("{}\n", json).as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
        port.flush()
            .map_err(|e| format!("Flush failed: {}", e))?;

        Ok((cmd_id, rx))
    }

    pub fn send_command_safe(
        state: &Arc<Mutex<SerialManager>>,
        cmd: SerialCommand,
    ) -> Result<DeviceMessage, String> {
        Self::send_command_safe_with_retries(state, cmd, 1)
    }

    pub fn send_command_safe_with_retries(
        state: &Arc<Mutex<SerialManager>>,
        cmd: SerialCommand,
        retries: u32,
    ) -> Result<DeviceMessage, String> {
        let timeout = std::time::Duration::from_secs(3);

        for attempt in 0..=retries {
            let cmd_clone = SerialCommand {
                cmd: cmd.cmd.clone(),
                value: cmd.value,
            };
            let cmd_name = cmd_clone.cmd.clone();

            // A booting device rejects writes with os error 121: retry.
            let (cmd_id, rx) = match {
                let mut mgr = lock_or_recover(state);
                mgr.prepare_command(cmd_clone)
            } {
                Ok(v) => v,
                Err(e) => {
                    if attempt < retries {
                        eprintln!("[CMD] {} -> WRITE_ERR ({}), retry {}/{}", cmd_name, e, attempt + 1, retries);
                        std::thread::sleep(std::time::Duration::from_millis(1000));
                        continue;
                    } else {
                        eprintln!("[CMD] {} -> WRITE_ERR final: {}", cmd_name, e);
                        return Err(e);
                    }
                }
            };

            match rx.recv_timeout(timeout) {
                Ok(result) => {
                    if let Err(e) = &result {
                        eprintln!("[CMD] {} -> ERR: {}", cmd_name, e);
                    }
                    return result;
                }
                Err(_) => {
                    let mut mgr = lock_or_recover(state);
                    mgr.cmd_queue.retain(|(id, _, _)| *id != cmd_id);

                    if attempt < retries {
                        eprintln!("[CMD] {} -> TIMEOUT, retry {}/{}", cmd_name, attempt + 1, retries);
                        drop(mgr);
                        std::thread::sleep(std::time::Duration::from_millis(200));
                    } else {
                        eprintln!("[CMD] {} -> TIMEOUT ({}s)", cmd_name, timeout.as_secs());
                        return Err(format!("Command timeout: {}", cmd_name));
                    }
                }
            }
        }
        unreachable!()
    }

    /// A caller that gives up must call `clear_events_collector`.
    pub fn prepare_events_stream(
        &mut self,
    ) -> Result<mpsc::Receiver<Result<DeviceMessage, String>>, String> {
        if self.events_collector.is_some() {
            return Err("Event stream already in progress".to_string());
        }
        let port = self.port.as_mut().ok_or("Not connected")?;

        let (tx, rx) = mpsc::channel();
        self.events_collector = Some(tx);

        let json = r#"{"cmd":"get_events"}"#;
        port.write_all(format!("{}\n", json).as_bytes())
            .map_err(|e| {
                self.events_collector = None;
                format!("Write failed: {}", e)
            })?;
        port.flush().map_err(|e| {
            self.events_collector = None;
            format!("Flush failed: {}", e)
        })?;

        Ok(rx)
    }

    pub fn clear_events_collector(&mut self) {
        self.events_collector = None;
    }

    /// For commands whose payload doesn't fit SerialCommand (OTA, set_time).
    pub fn prepare_raw_command(
        &mut self,
        cmd_name: &str,
        json: &str,
    ) -> Result<(u64, mpsc::Receiver<Result<DeviceMessage, String>>), String> {
        let port = self.port.as_mut().ok_or("Not connected")?;

        let cmd_id = self.next_cmd_id;
        self.next_cmd_id += 1;

        let (tx, rx) = mpsc::channel();
        self.cmd_queue.push_back((cmd_id, cmd_name.to_string(), tx));

        port.write_all(format!("{}\n", json).as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
        port.flush()
            .map_err(|e| format!("Flush failed: {}", e))?;

        Ok((cmd_id, rx))
    }

    pub fn send_raw_command_safe(
        state: &Arc<Mutex<SerialManager>>,
        cmd_name: &str,
        json: &str,
        timeout: std::time::Duration,
    ) -> Result<DeviceMessage, String> {
        Self::send_raw_command_safe_with_retries(state, cmd_name, json, timeout, 1)
    }

    pub fn send_raw_command_safe_with_retries(
        state: &Arc<Mutex<SerialManager>>,
        cmd_name: &str,
        json: &str,
        timeout: std::time::Duration,
        retries: u32,
    ) -> Result<DeviceMessage, String> {
        for attempt in 0..=retries {
            let (cmd_id, rx) = {
                let mut mgr = lock_or_recover(state);
                mgr.prepare_raw_command(cmd_name, json)?
            };

            match rx.recv_timeout(timeout) {
                Ok(result) => return result,
                Err(_) => {
                    let mut mgr = lock_or_recover(state);
                    mgr.cmd_queue.retain(|(id, _, _)| *id != cmd_id);

                    if attempt < retries {
                        eprintln!("[CMD] {} -> TIMEOUT, retry {}/{}", cmd_name, attempt + 1, retries);
                        drop(mgr);
                        std::thread::sleep(std::time::Duration::from_millis(200));
                    } else {
                        return Err(format!("Command timeout: {}", cmd_name));
                    }
                }
            }
        }
        unreachable!()
    }

    pub fn disconnect(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
        self.port = None;
        self.connected_path = None;
        self.config = None;
        self.drain_cmd_queue();

        // The reader checks stop_rx between short read timeouts, so join returns quickly.
        if let Some(handle) = self.reader_handle.take() {
            let _ = handle.join();
        }
    }

    /// Called by the reader thread on device loss.
    fn cleanup(&mut self) {
        self.stop_tx = None;
        self.port = None;
        self.connected_path = None;
        self.drain_cmd_queue();
        // Keep config and frames so the frontend can still show them.
    }

    /// Unblocks pending waiters with Err("Disconnected").
    fn drain_cmd_queue(&mut self) {
        while let Some((_, _, tx)) = self.cmd_queue.pop_front() {
            let _ = tx.send(Err("Disconnected".to_string()));
        }
        if let Some(tx) = self.events_collector.take() {
            let _ = tx.send(Err("Disconnected".to_string()));
        }
    }
}
