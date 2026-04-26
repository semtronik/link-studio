use serde::{Deserialize, Serialize};

// --- Types envoyes au device ---
#[derive(Debug, Clone, Serialize)]
pub struct SerialCommand {
    pub cmd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

// --- Types recus du device ---
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
        /// MAC efuse factory du LFT, format "AA:BB:CC:DD:EE:FF". Identifiant
        /// hardware unique. Présent à partir du firmware qui expose ce champ.
        #[serde(default)]
        mac: Option<String>,
        #[serde(default)]
        partition: Option<String>,
        #[serde(default)]
        written: Option<f64>,
        /// Phase d'un stream multi-messages (get_events : "begin" / "end").
        /// None pour les ack mono-message classiques.
        #[serde(default)]
        phase: Option<String>,
        /// Nombre d'events streamés (présent sur ack phase=end de get_events).
        #[serde(default)]
        count: Option<u32>,
    },
    /// Ligne de journal système streamée en réponse à get_events.
    /// Envoyée entre les ack phase=begin et phase=end.
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

// --- Types exposes au frontend ---
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoRaConfig {
    pub freq: f64,
    pub sf: u8,
    pub bw: f64,
    pub drops: u32,
}

impl LoRaConfig {
    /// Arrondit freq à 1 décimale pour compenser l'imprécision float32 firmware.
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
    /// Identification firmware si le port a été probé avec succès. Permet
    /// à l'UI d'afficher "LFT V1 (v0.2.3)" plutôt que "USB JTAG/serial debug
    /// unit". None tant que le probe n'a pas eu lieu ou a échoué.
    #[serde(default)]
    pub firmware: Option<PortFirmwareInfo>,
    /// True tant que le scanner considère ce port candidat à un LFT mais
    /// n'a pas encore tranché. L'UI affiche alors un spinner plutôt que le
    /// label générique VID/PID — évite de faire croire que le port est une
    /// boîte vide alors qu'on est en train de l'identifier.
    #[serde(default)]
    pub identifying: bool,
    /// True si le port est monopolisé par une autre application (Arduino IDE,
    /// PuTTY, moniteur série…). Détecté par un échec d'ouverture immédiat
    /// lors du probe. L'UI affiche "Utilisé par une autre application" et
    /// bloque la sélection, pour éviter un connect qui échouerait de toute
    /// façon avec PortBusy.
    #[serde(default)]
    pub busy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortFirmwareInfo {
    pub profile: FirmwareProfile,
    pub product: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,
    pub mac: Option<String>,
}

// --- Commandes valides ---
// Commandes exposées au frontend via `invoke('send_command', ...)`. Les
// commandes temps (set_time/get_time) ne sont PAS ici car elles transitent
// par `sync_time` (payload JSON custom avec offset_min, non supporté par
// SerialCommand{cmd,value}).
pub const VALID_COMMANDS: &[&str] = &[
    "get_config", "set_freq", "set_sf", "set_bw",
    "get_version", "ota_begin", "ota_data", "ota_end", "reboot",
];

// Commandes utilisables en interne par send_command_safe (inclut get_time
// qui est appelé par la commande Tauri sync_time).
pub const INTERNAL_COMMANDS: &[&str] = &[
    "get_config", "set_freq", "set_sf", "set_bw", "get_time",
    "get_version", "ota_begin", "ota_data", "ota_end", "reboot",
    "get_events",
];

/// Entrée de journal système remontée au frontend par la commande Tauri
/// `get_events`. `line` est le texte brut stocké par le firmware (ex :
/// "2026-04-15T14:32:09Z CHARGE_START pct=34"). Le parsing timestamp /
/// event / details est fait côté front pour laisser la flexibilité d'UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventLogEntry {
    pub line: String,
    pub seq: u32,
}

// --- Resultat auto_setup ---
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSetupResult {
    pub config: LoRaConfig,
    pub port: String,
}

// --- Profil firmware ---
// LftV1 : firmware LFT V1+ (expose product="LFT", model="v1"). Supporte sync
// heure, timestamps UTC des trames, enregistrement futur.
// Legacy : firmware DevKit V0 (pas de product/model). Pas de réglage heure,
// timestamps PC au lieu du device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FirmwareProfile {
    LftV1,
    Legacy,
}

impl FirmwareProfile {
    /// Détermine le profil à partir de la réponse `get_version`. Le LFT V1
    /// renvoie `product:"LFT"` et `model:"v1"`. Tout le reste = legacy.
    pub fn from_version_ack(product: Option<&str>, model: Option<&str>) -> Self {
        match (product, model) {
            (Some("LFT"), Some("v1")) => FirmwareProfile::LftV1,
            _ => FirmwareProfile::Legacy,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareInfo {
    pub profile: FirmwareProfile,
    pub product: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,
    pub build_date: Option<String>,
    pub mac: Option<String>,
}

// --- Events streames via Channel ---
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

// --- Constantes LoRa ---
// Exposees au frontend via get_valid_params() pour peupler les selects/dropdowns.
// La validation reelle est faite par le firmware ESP-IDF (device-side backstop).
pub const VALID_BANDWIDTHS: &[f64] = &[125.0, 250.0, 500.0];
pub const SPREADING_FACTORS: &[u8] = &[7, 8, 9, 10, 11, 12];
