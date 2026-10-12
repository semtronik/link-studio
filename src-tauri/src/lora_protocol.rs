use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Replies the backend reads itself. See link/protocol/v1/protocol.md.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum DeviceMessage {
    #[serde(rename = "ack")]
    Ack {
        cmd: String,
        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        build_date: Option<String>,
        #[serde(default)]
        product: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        mac: Option<String>,
        /// "begin" / "end" around a streamed reply.
        #[serde(default)]
        phase: Option<String>,
        #[serde(default)]
        profile: Option<Value>,
    },
    #[serde(rename = "err")]
    Error { cmd: String, msg: String },
    #[serde(rename = "time")]
    Time {
        utc: f64,
        #[serde(default)]
        valid: Option<bool>,
    },
    #[serde(rename = "event")]
    Event {
        line: String,
        #[serde(default)]
        seq: Option<u32>,
    },
}

/// One line from the device, sorted by what the backend does with it.
#[derive(Debug, Clone)]
pub enum Incoming {
    Reply(DeviceMessage),
    /// Recording line (`session`, `end`, `rx`, `tx`, `gap`, `lost`), passed on
    /// untouched: the frontend parses device lines and files alike.
    Record(Value),
    /// `session_info`, from `get_sessions`.
    SessionInfo(Value),
}

const RECORD_TYPES: &[&str] = &["session", "end", "rx", "tx", "gap", "lost"];

pub fn parse_line(line: &str) -> Option<Incoming> {
    let v: Value = serde_json::from_str(line).ok()?;
    let ty = v.get("type")?.as_str()?;
    if RECORD_TYPES.contains(&ty) {
        Some(Incoming::Record(v))
    } else if ty == "session_info" {
        Some(Incoming::SessionInfo(v))
    } else {
        serde_json::from_value(v).ok().map(Incoming::Reply)
    }
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

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum SerialEvent {
    /// A recording line pushed live by the device.
    #[serde(rename = "line")]
    Line(Value),
    #[serde(rename = "disconnected")]
    Disconnected,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_lines_by_type() {
        assert!(matches!(
            parse_line(r#"{"type":"rx","ts":1,"status":"ok"}"#),
            Some(Incoming::Record(_))
        ));
        assert!(matches!(
            parse_line(r#"{"type":"session_info","id":3,"current":true}"#),
            Some(Incoming::SessionInfo(_))
        ));
        assert!(matches!(
            parse_line(r#"{"type":"ack","cmd":"get_profile","status":"ok","profile":{"sf":7}}"#),
            Some(Incoming::Reply(DeviceMessage::Ack { profile: Some(_), .. }))
        ));
        assert!(parse_line("I (123) boot: log line").is_none());
        assert!(parse_line(r#"{"type":"screenshot","seq":0}"#).is_none());
    }
}
