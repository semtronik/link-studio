use crate::lora_protocol::*;
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::ipc::Channel;

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

type Reply = Result<Incoming, String>;

pub const STREAM_BUSY: &str = "Another transfer is in progress";

/// A command whose reply spans several lines, bracketed by `phase` acks.
struct Stream {
    cmd: String,
    tx: mpsc::Sender<Reply>,
    begun: bool,
    /// get_session on the running session: live lines before `begin` are
    /// repeated in the stream.
    drop_live_before_begin: bool,
}

pub struct SerialManager {
    port: Option<Box<dyn serialport::SerialPort>>,
    connected_path: Option<String>,
    connecting_path: Option<String>,
    stop_tx: Option<mpsc::Sender<()>>,
    reader_handle: Option<JoinHandle<()>>,
    cmd_queue: VecDeque<(u64, String, mpsc::Sender<Reply>)>,
    next_cmd_id: u64,
    stream: Option<Stream>,
    /// Running session, from get_sessions or the last live `session` line.
    live_session_id: Option<u64>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            port: None,
            connected_path: None,
            connecting_path: None,
            stop_tx: None,
            reader_handle: None,
            cmd_queue: VecDeque::new(),
            next_cmd_id: 0,
            stream: None,
            live_session_id: None,
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

    pub fn live_session_id(&self) -> Option<u64> {
        self.live_session_id
    }

    pub fn set_live_session_id(&mut self, id: Option<u64>) {
        self.live_session_id = id;
    }

    /// Called with the lock held: `state` is for the reader thread only, never
    /// lock it here (deadlock).
    pub fn connect(
        &mut self,
        port_name: &str,
        channel: Channel<SerialEvent>,
        state: Arc<Mutex<SerialManager>>,
    ) -> Result<(), ConnectError> {
        if self.port.is_some() {
            return Err(ConnectError::Other {
                port: port_name.to_string(),
                raw: "already_connected".to_string(),
            });
        }

        // USB CDC ignores the baud rate.
        let mut port = serialport::new(port_name, 115200)
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
        self.live_session_id = None;

        let handle = std::thread::spawn(move || {
            let mut reader = BufReader::new(reader_port);
            // Bytes, not String: a read timing out mid-line keeps what it got,
            // and the line completes on a later read.
            let mut line_buf: Vec<u8> = Vec::new();

            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }

                match reader.read_until(b'\n', &mut line_buf) {
                    Ok(0) => {
                        crate::log_warn("Disconnect (EOF on serial read)");
                        let _ = channel.send(SerialEvent::Disconnected);
                        let mut mgr = lock_or_recover(&state);
                        mgr.cleanup();
                        break;
                    }
                    Ok(_) => {
                        if line_buf.last() != Some(&b'\n') {
                            continue;
                        }
                        let raw = std::mem::take(&mut line_buf);
                        if raw.len() > MAX_LINE_LEN {
                            continue;
                        }
                        let text = String::from_utf8_lossy(&raw);
                        let trimmed = text.trim();
                        if !trimmed.starts_with('{') {
                            continue;
                        }
                        // Parse outside the lock.
                        if let Some(msg) = parse_line(trimmed) {
                            let mut mgr = lock_or_recover(&state);
                            mgr.dispatch(msg, &channel);
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                        if line_buf.len() > MAX_LINE_LEN {
                            line_buf.clear();
                        }
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

    fn dispatch(&mut self, msg: Incoming, channel: &Channel<SerialEvent>) {
        match msg {
            Incoming::Record(line) => {
                if let Some(s) = self.stream.as_ref() {
                    if s.cmd == "get_session" {
                        if s.begun {
                            let _ = s.tx.send(Ok(Incoming::Record(line)));
                            return;
                        }
                        if s.drop_live_before_begin {
                            return;
                        }
                    }
                }
                if line.get("type").and_then(|t| t.as_str()) == Some("session") {
                    self.live_session_id = line.get("id").and_then(|v| v.as_u64());
                }
                let _ = channel.send(SerialEvent::Line(line));
            }
            Incoming::SessionInfo(_) => {
                if let Some(s) = self.stream.as_ref() {
                    let _ = s.tx.send(Ok(msg));
                }
            }
            Incoming::Reply(ref reply) => match reply {
                DeviceMessage::Ack { cmd, phase, .. } => {
                    if self.stream.as_ref().is_some_and(|s| &s.cmd == cmd) {
                        let s = self.stream.as_mut().unwrap();
                        match phase.as_deref() {
                            Some("begin") => s.begun = true,
                            Some("end") => {
                                let _ = s.tx.send(Ok(msg));
                                self.stream = None;
                                return;
                            }
                            _ => {}
                        }
                        let _ = s.tx.send(Ok(msg));
                        return;
                    }
                    let cmd = cmd.clone();
                    self.resolve(&cmd, msg);
                }
                DeviceMessage::Error { cmd, .. } => {
                    if self.stream.as_ref().is_some_and(|s| &s.cmd == cmd) {
                        let s = self.stream.take().unwrap();
                        let _ = s.tx.send(Ok(msg));
                        return;
                    }
                    let cmd = cmd.clone();
                    self.resolve(&cmd, msg);
                }
                DeviceMessage::Event { .. } => {
                    if let Some(s) = self.stream.as_ref() {
                        let _ = s.tx.send(Ok(msg));
                    }
                }
                DeviceMessage::Time { .. } => self.resolve("get_time", msg),
            },
        }
    }

    /// Matching by name is enough: commands are sent one at a time.
    fn resolve(&mut self, cmd: &str, msg: Incoming) {
        if self.cmd_queue.front().is_some_and(|(_, c, _)| c == cmd) {
            let (_, _, tx) = self.cmd_queue.pop_front().unwrap();
            let _ = tx.send(Ok(msg));
        }
    }

    fn write_line(&mut self, json: &str) -> Result<(), String> {
        let port = self.port.as_mut().ok_or("Not connected")?;
        port.write_all(format!("{}\n", json).as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
        port.flush().map_err(|e| format!("Flush failed: {}", e))
    }

    /// The caller must release the lock before waiting on the receiver.
    fn prepare_command(
        &mut self,
        cmd_name: &str,
        json: &str,
    ) -> Result<(u64, mpsc::Receiver<Reply>), String> {
        if self.port.is_none() {
            return Err("Not connected".to_string());
        }
        let cmd_id = self.next_cmd_id;
        self.next_cmd_id += 1;

        let (tx, rx) = mpsc::channel();
        self.cmd_queue.push_back((cmd_id, cmd_name.to_string(), tx));
        if let Err(e) = self.write_line(json) {
            self.cmd_queue.retain(|(id, _, _)| *id != cmd_id);
            return Err(e);
        }
        Ok((cmd_id, rx))
    }

    /// Sends `json` and waits for the ack, err or time line answering `cmd_name`.
    pub fn send(
        state: &Arc<Mutex<SerialManager>>,
        cmd_name: &str,
        json: &str,
        timeout: std::time::Duration,
        retries: u32,
    ) -> Result<DeviceMessage, String> {
        for attempt in 0..=retries {
            // A booting device rejects writes with os error 121: retry.
            let (cmd_id, rx) = match lock_or_recover(state).prepare_command(cmd_name, json) {
                Ok(v) => v,
                Err(e) if attempt < retries => {
                    eprintln!("[CMD] {} -> WRITE_ERR ({}), retry {}/{}", cmd_name, e, attempt + 1, retries);
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                    continue;
                }
                Err(e) => return Err(e),
            };

            match rx.recv_timeout(timeout) {
                Ok(Ok(Incoming::Reply(reply))) => return Ok(reply),
                Ok(Ok(_)) => return Err(format!("Unexpected reply to {}", cmd_name)),
                Ok(Err(e)) => return Err(e),
                Err(_) => {
                    lock_or_recover(state).cmd_queue.retain(|(id, _, _)| *id != cmd_id);
                    if attempt < retries {
                        eprintln!("[CMD] {} -> TIMEOUT, retry {}/{}", cmd_name, attempt + 1, retries);
                        std::thread::sleep(std::time::Duration::from_millis(200));
                    } else {
                        return Err(format!("Command timeout: {}", cmd_name));
                    }
                }
            }
        }
        unreachable!()
    }

    /// A caller that gives up must call `end_stream`.
    pub fn start_stream(
        &mut self,
        cmd_name: &str,
        json: &str,
        drop_live_before_begin: bool,
    ) -> Result<mpsc::Receiver<Reply>, String> {
        if self.stream.is_some() {
            return Err(STREAM_BUSY.to_string());
        }
        let (tx, rx) = mpsc::channel();
        self.stream = Some(Stream {
            cmd: cmd_name.to_string(),
            tx,
            begun: false,
            drop_live_before_begin,
        });
        if let Err(e) = self.write_line(json) {
            self.stream = None;
            return Err(e);
        }
        Ok(rx)
    }

    pub fn end_stream(&mut self) {
        self.stream = None;
    }

    pub fn disconnect(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
        self.port = None;
        self.connected_path = None;
        self.live_session_id = None;
        self.drain_pending();

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
        self.live_session_id = None;
        self.drain_pending();
    }

    /// Unblocks pending waiters with Err("Disconnected").
    fn drain_pending(&mut self) {
        while let Some((_, _, tx)) = self.cmd_queue.pop_front() {
            let _ = tx.send(Err("Disconnected".to_string()));
        }
        if let Some(s) = self.stream.take() {
            let _ = s.tx.send(Err("Disconnected".to_string()));
        }
    }
}
