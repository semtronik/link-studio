use serde::{Deserialize, Serialize};

// --- Sent to the device ---
#[derive(Debug, Clone, Serialize)]
pub struct SerialCommand {
    pub cmd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

// --- Received from the device ---
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DeviceMessage {
    #[serde(rename = "pkt")]
    Packet {
        ts: Option<f64>,
        rssi: Option<f64>,
        snr: Option<f64>,
        len: Option<u32>,
        data: Option<String>,
    },
    #[serde(rename = "frame")]
    Frame {
        ts: Option<f64>,
        timestamp: Option<f64>,
        rssi: Option<f64>,
        snr: Option<f64>,
        hex: Option<String>,
        data: Option<String>,
    },
    #[serde(rename = "cfg")]
    Config {
        #[serde(default)]
        freq: Option<f64>,
        #[serde(default)]
        sf: Option<u8>,
        #[serde(default)]
        bw: Option<f64>,
        #[serde(default)]
        drops: Option<u32>,
    },
    #[serde(rename = "ack")]
    Ack {
        cmd: String,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        build_date: Option<String>,
        #[serde(default)]
        product: Option<String>,
        #[serde(default)]
        model: Option<String>,
        /// Factory efuse MAC, "AA:BB:CC:DD:EE:FF". Absent on older firmware.
        #[serde(default)]
        mac: Option<String>,
        #[serde(default)]
        partition: Option<String>,
        #[serde(default)]
        written: Option<f64>,
        /// Multi-message stream phase (get_events: "begin" / "end").
        #[serde(default)]
        phase: Option<String>,
        /// Streamed event count, on the get_events phase=end ack.
        #[serde(default)]
        count: Option<u32>,
    },
    /// get_events log line, sent between the phase=begin and phase=end acks.
    #[serde(rename = "event")]
    Event {
        line: String,
        #[serde(default)]
        seq: Option<u32>,
    },
    #[serde(rename = "time")]
    Time {
        utc: f64,
        #[serde(default)]
        offset_min: Option<i32>,
        #[serde(default)]
        valid: Option<bool>,
    },
    #[serde(rename = "err")]
    Error {
        cmd: String,
        msg: String,
    },
}

// --- Exposed to the frontend ---
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoRaConfig {
    pub freq: f64,
    pub sf: u8,
    pub bw: f64,
    pub drops: u32,
}

impl LoRaConfig {
    /// Rounds freq to absorb the firmware's float32 error.
    pub fn sanitized(mut self) -> Self {
        self.freq = (self.freq * 1000.0).round() / 1000.0;
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameData {
    pub id: String,
    #[serde(rename = "type")]
    pub frame_type: String,
    pub hex: String,
    pub timestamp: f64,
    pub rssi: Option<f64>,
    pub snr: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameStats {
    pub count: usize,
    pub avg_rssi: Option<f64>,
    pub avg_snr: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub path: String,
    pub manufacturer: String,
    pub product: String,
    pub vid: String,
    pub pid: String,
    pub serial_number: String,
    pub port_type: String,
    /// None until a probe has identified the device.
    #[serde(default)]
    pub firmware: Option<PortFirmwareInfo>,
    /// Probe still in progress.
    #[serde(default)]
    pub identifying: bool,
    /// Held by another application; connecting would fail with PortBusy.
    #[serde(default)]
    pub busy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortFirmwareInfo {
    pub kind: DeviceKind,
    pub product: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,
    pub mac: Option<String>,
}

// Commands the frontend may send via `send_command`. Time commands go through
// `sync_time` instead: their payload carries offset_min, which SerialCommand can't.
pub const VALID_COMMANDS: &[&str] = &[
    "get_config", "set_freq", "set_sf", "set_bw",
    "get_version", "ota_begin", "ota_data", "ota_end", "reboot",
];

// Commands allowed internally by send_command_safe.
pub const INTERNAL_COMMANDS: &[&str] = &[
    "get_config", "set_freq", "set_sf", "set_bw", "get_time",
    "get_version", "ota_begin", "ota_data", "ota_end", "reboot",
    "get_events",
];

/// Raw device log line, e.g. "2026-04-15T14:32:09Z CHARGE_START pct=34";
/// parsed by the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventLogEntry {
    pub line: String,
    pub seq: u32,
}

/// What answered `get_version`. Only `LinkLr` is supported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceKind {
    LinkLr,
    Lft,
    Unknown,
}

impl DeviceKind {
    pub fn from_version_ack(product: Option<&str>, model: Option<&str>) -> Self {
        match (product, model) {
            (Some("Link"), Some("Link-LR")) => DeviceKind::LinkLr,
            (Some("LFT"), _) => DeviceKind::Lft,
            _ => DeviceKind::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareInfo {
    pub kind: DeviceKind,
    pub product: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,
    pub build_date: Option<String>,
    pub mac: Option<String>,
}

// --- Events streamed via Channel ---
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum SerialEvent {
    #[serde(rename = "frame")]
    Frame(FrameData),
    #[serde(rename = "config")]
    Config(LoRaConfig),
    #[serde(rename = "stats")]
    Stats(FrameStats),
    #[serde(rename = "firmware")]
    Firmware(FirmwareInfo),
    #[serde(rename = "disconnected")]
    Disconnected,
}

// LoRa options for the frontend selects; the firmware does the real validation.
pub const VALID_BANDWIDTHS: &[f64] = &[125.0, 250.0, 500.0];
pub const SPREADING_FACTORS: &[u8] = &[7, 8, 9, 10, 11, 12];
