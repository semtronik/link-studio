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

/// Taille max d'une ligne lue depuis le port serie (protection memoire — F16)
const MAX_LINE_LEN: usize = 8192;

/// Recupere le MutexGuard sans paniquer en cas de mutex empoisonne (F1).
/// Si un thread precedent a paniqué pendant qu'il tenait le lock, on recupere
/// l'inner value — le state peut etre inconsistant mais l'app ne crashe pas.
fn lock_or_recover(state: &Arc<Mutex<SerialManager>>) -> std::sync::MutexGuard<'_, SerialManager> {
    state.lock().unwrap_or_else(|poisoned| {
        eprintln!("[serial_manager] Mutex empoisonne, recuperation du state");
        poisoned.into_inner()
    })
}

/// Erreur structurée renvoyée au frontend lors de l'ouverture d'un port
/// série. Sérialisée avec `tag = "code"` → JSON `{ "code": "port_busy",
/// "port": "COM3", "raw": "..." }`. Le frontend mappe `code` → message
/// localisé, `raw` reste disponible pour debug/log.
///
/// Codes :
///   port_busy          : port utilisé par une autre application
///   port_not_found     : port inexistant ou device débranché
///   permission_denied  : droits insuffisants (Linux : groupe dialout/uucp)
///   invalid_settings   : config (baudrate, bits, ...) refusée par le driver
///   other              : tout le reste, inclure raw pour diagnostic
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ConnectError {
    PortBusy { port: String, raw: String },
    PortNotFound { port: String, raw: String },
    PermissionDenied { port: String, raw: String },
    InvalidSettings { port: String, raw: String },
    Other { port: String, raw: String },
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::PortBusy { port, raw } => write!(f, "port_busy({}): {}", port, raw),
            ConnectError::PortNotFound { port, raw } => write!(f, "port_not_found({}): {}", port, raw),
            ConnectError::PermissionDenied { port, raw } => write!(f, "permission_denied({}): {}", port, raw),
            ConnectError::InvalidSettings { port, raw } => write!(f, "invalid_settings({}): {}", port, raw),
            ConnectError::Other { port, raw } => write!(f, "other({}): {}", port, raw),
        }
    }
}

/// Classifie une erreur `serialport::Error` en variant `ConnectError`
/// portable. La détection s'appuie sur :
///   1. le `serialport::ErrorKind` (sémantique, prioritaire)
///   2. le code OS numérique sous-jacent (`raw_os_error()`) — universel,
///      pas localisé
///
/// Distinction `port_busy` vs `permission_denied` :
/// sur Windows, `EACCES (5)` signifie quasi toujours "port occupé"
/// (les permissions Windows sur ports série sont rarement le souci).
/// Sur Linux/Mac, `EACCES (13)` signifie typiquement "groupe dialout
/// manquant" — un vrai problème de permissions. `EBUSY (16)` reste
/// sans ambiguïté = occupé sur ces OS.
pub fn classify_open_error(port_name: &str, e: &serialport::Error) -> ConnectError {
    use serialport::ErrorKind;

    crate::log_warn(&format!(
        "open {} failed: kind={:?} description={:?}",
        port_name, e.kind, e.description
    ));

    let raw = e.description.clone();
    let port = port_name.to_string();

    // Stratégie de récupération du code OS, dans l'ordre :
    //   1. parse "os error N" dans la description (rare en pratique sur Windows
    //      car serialport convertit certaines erreurs en NoDevice et perd le code)
    //   2. probe std::fs sur le device : ouvre le device "à la main" via
    //      l'API standard ; en cas d'échec, io::Error::raw_os_error() donne
    //      le code OS fiable, indépendamment de la langue système.
    //
    // On doit récupérer un code fiable AVANT de classifier — sinon NoDevice
    // est ambigu (port absent OU port occupé selon les drivers Windows).
    let os_code = extract_raw_os_error(e).or_else(|| probe_os_error(port_name));

    crate::log_warn(&format!("open {} resolved os_code={:?}", port_name, os_code));

    // Classification basée d'abord sur le code OS (universel, pas localisé),
    // puis fallback sur les ErrorKind pour les cas où aucun code n'est dispo.
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

    // Pas de code OS exploitable → fallback sur le ErrorKind sémantique.
    match e.kind {
        ErrorKind::NoDevice => ConnectError::PortNotFound { port, raw },
        ErrorKind::InvalidInput => ConnectError::InvalidSettings { port, raw },
        ErrorKind::Io(_) | ErrorKind::Unknown => ConnectError::Other { port, raw },
    }
}

/// Extrait le code OS numérique de la description d'une serialport::Error
/// quand le format inclut "os error N". Cas relativement rare en pratique
/// car serialport reformate souvent les erreurs Win32 en `NoDevice` sans
/// conserver le code.
fn extract_raw_os_error(e: &serialport::Error) -> Option<i32> {
    let desc = &e.description;
    let idx = desc.find("os error ")?;
    let rest = &desc[idx + "os error ".len()..];
    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse::<i32>().ok()
}

/// Fallback fiable et cross-OS : tente d'ouvrir le device avec l'API std
/// pour récupérer un code OS numérique via `io::Error::raw_os_error()`.
///
/// Sur Windows, le chemin canonique d'un port série pour CreateFileW est
/// `\\.\COMx` (le préfixe `\\.\` permet d'accéder aux ports COM10+).
/// Sur Linux/Mac, le port est `/dev/...` ; on ouvre avec O_NONBLOCK pour
/// éviter tout blocage sur les drivers série qui attendent DCD avant de
/// rendre la main (cas réel sur Mac avec certains adaptateurs USB-série).
///
/// Garde absolue : l'open est exécuté dans un thread séparé avec un
/// timeout de 500 ms. Si l'open ne rend pas la main dans ce délai
/// (cas pathologique driver buggé / device fantôme), on abandonne et
/// retourne None — l'appelant retombera sur la classification par
/// `ErrorKind` ou `ConnectError::Other`. Garantit l'absence de blocage UX.
///
/// Cette fonction est appelée uniquement quand serialport a déjà échoué,
/// donc on ne perturbe pas le flux normal.
fn probe_os_error(port_name: &str) -> Option<i32> {
    let port_owned = port_name.to_string();

    let (tx, rx) = std::sync::mpsc::channel::<Option<i32>>();
    std::thread::spawn(move || {
        let result = probe_os_error_blocking(&port_owned);
        let _ = tx.send(result); // ignore si receiver a déjà timeout
    });

    // Timeout 500 ms : largement suffisant pour un open OS qui rend
    // immédiatement la main en cas d'erreur, mais court si jamais ça bloque.
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

/// Implémentation de l'open de probe — peut bloquer sur certains drivers,
/// d'où l'exécution dans un thread séparé avec timeout côté appelant.
fn probe_os_error_blocking(port_name: &str) -> Option<i32> {
    use std::fs::OpenOptions;

    let path = if cfg!(target_os = "windows") {
        // Préfixe \\.\ obligatoire pour COM10+ ; safe pour COM1-9.
        format!(r"\\.\{}", port_name)
    } else {
        port_name.to_string()
    };

    let mut opts = OpenOptions::new();
    opts.read(true).write(true);

    // Sur Unix : O_NONBLOCK pour éviter tout blocage sur drivers série
    // qui attendent DCD (cas réel sur Mac avec certains adaptateurs).
    // O_NONBLOCK = 0x800 sur Linux, 0x4 sur macOS — on utilise les
    // constantes std via custom_flags.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // libc::O_NONBLOCK est portable Unix. On ne dépend pas de libc :
        // les valeurs sont stables dans la std (cf. man open).
        const O_NONBLOCK: i32 = if cfg!(target_os = "macos") { 0x0004 } else { 0x0800 };
        opts.custom_flags(O_NONBLOCK);
    }

    let result = opts.open(&path);
    match result {
        Ok(_handle) => None, // l'open a réussi inopinément, on ne sait pas trancher
        Err(io_err) => io_err.raw_os_error(),
    }
}

/// Codes OS signifiant "ressource occupée par autre process".
fn is_busy_code(code: i32) -> bool {
    if cfg!(target_os = "windows") {
        // ERROR_ACCESS_DENIED = 5, ERROR_SHARING_VIOLATION = 32
        code == 5 || code == 32
    } else {
        // EBUSY = 16 (Linux/Mac : sans ambiguïté = occupé)
        code == 16
    }
}

/// Codes OS signifiant "ressource introuvable".
fn is_not_found_code(code: i32) -> bool {
    if cfg!(target_os = "windows") {
        // ERROR_FILE_NOT_FOUND = 2
        code == 2
    } else {
        // ENOENT = 2, ENXIO = 6, ENODEV = 19
        code == 2 || code == 6 || code == 19
    }
}

/// Codes OS signifiant "permission refusée".
fn is_permission_code(code: i32) -> bool {
    if cfg!(target_os = "windows") {
        false // sur Windows, EACCES (5) est traité comme busy
    } else {
        // EACCES = 13, EPERM = 1
        code == 13 || code == 1
    }
}

/// Sur les plateformes où EACCES peut signifier "occupé" OU "permissions
/// manquantes" (Windows), on classe en busy. Sur Linux/Mac on classe
/// EACCES comme un vrai problème de permissions (groupe dialout/uucp).
fn classify_permission_or_busy(port: String, raw: String) -> ConnectError {
    if cfg!(target_os = "windows") {
        ConnectError::PortBusy { port, raw }
    } else {
        ConnectError::PermissionDenied { port, raw }
    }
}

/* ============================================================
 * Tests unitaires — classification cross-OS
 *
 * Ces tests valident que les codes errno/Win32 sont correctement
 * mappés sur chaque plateforme. cargo test sur Windows valide la
 * branche Windows ; cargo test sur Linux/Mac valide la branche Unix.
 *
 * Pas besoin de hardware, pas d'I/O — pure logique de classification.
 * ============================================================ */
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
            // Sur Windows, EACCES (5) est traité comme busy via une
            // autre branche, pas via is_permission_code.
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
            description: "Accès refusé.".to_string(),
        };
        assert_eq!(extract_raw_os_error(&e), None);
    }

    #[test]
    fn connect_error_serializes_with_code_field() {
        let e = ConnectError::PortBusy {
            port: "COM3".into(),
            raw: "Accès refusé.".into(),
        };
        let json = serde_json::to_string(&e).unwrap();
        // Contrat avec le frontend : { "code": "port_busy", "port": ..., "raw": ... }
        assert!(json.contains(r#""code":"port_busy""#));
        assert!(json.contains(r#""port":"COM3""#));
        assert!(json.contains(r#""raw":"Accès refusé.""#));
    }
}

pub struct SerialManager {
    port: Option<Box<dyn serialport::SerialPort>>,
    /// Path du port connecté (mirroir de `port.is_some()` pour exposition
    /// au scanner via `busy_path`). Remis à None par `disconnect`/`cleanup`.
    connected_path: Option<String>,
    /// Port dont l'ouverture est en cours dans `serial_connect`. Posé sous
    /// lock en début de commande, libéré en fin. Le scanner skip ce path
    /// pour éviter le conflit d'ouverture concurrente (Windows os error 121).
    connecting_path: Option<String>,
    stop_tx: Option<mpsc::Sender<()>>,
    reader_handle: Option<JoinHandle<()>>,
    pub frame_store: FrameStore,
    pub config: Option<LoRaConfig>,
    /// Profil firmware du device connecté. None tant que `get_version` n'a
    /// pas été résolu au connect. Utilisé pour gater les fonctionnalités
    /// (sync heure, timestamps UTC) selon le firmware en face.
    pub firmware_profile: Option<FirmwareProfile>,
    cmd_queue: VecDeque<(u64, String, mpsc::Sender<Result<DeviceMessage, String>>)>,
    next_cmd_id: u64,
    /// Collecteur actif pour le stream de `get_events`. Quand Some, le dispatcher
    /// route les messages `event` et les `ack cmd=get_events` vers ce channel au
    /// lieu de la cmd_queue. Remis à None quand `ack phase=end` est reçu (ou que
    /// l'appelant timeout et le nettoie).
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
            firmware_profile: None,
            cmd_queue: VecDeque::new(),
            next_cmd_id: 0,
            events_collector: None,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.port.is_some()
    }

    /// Marque un port comme étant en cours d'ouverture par `serial_connect`.
    /// Le scanner skip ce path pour ne pas essayer d'ouvrir le même COM en
    /// parallèle (os error 121 sous Windows). Appelé sous lock du mutex.
    pub fn begin_connecting(&mut self, port_name: &str) {
        self.connecting_path = Some(port_name.to_string());
    }

    /// Libère le flag `connecting_path`. À appeler dans tous les chemins de
    /// sortie de `serial_connect`, succès comme échec (via un guard RAII).
    pub fn end_connecting(&mut self) {
        self.connecting_path = None;
    }

    /// Retourne le path du port que le SerialManager considère occupé :
    /// soit connecté, soit en cours d'ouverture. Utilisé par le scanner
    /// pour ne probe que des ports libres.
    pub fn busy_path(&self) -> Option<&str> {
        self.connected_path
            .as_deref()
            .or(self.connecting_path.as_deref())
    }

    /// Ouvre le port serie et demarre le thread reader.
    /// ATTENTION: cette methode prend &mut self (via MutexGuard) ET un Arc<Mutex<Self>>.
    /// Le Arc est passe au reader thread uniquement. NE JAMAIS appeler state.lock() dans cette
    /// methode — cela deadlockerait.
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

        // Forcer DTR/RTS à inactif AVANT toute autre interaction (cohérent
        // avec probe_port_firmware). Évite que le driver USB-CDC ne pulse
        // ces lignes et déclenche un reset hardware sur les cartes ESP32
        // câblées comme les boards Arduino classiques.
        let _ = port.write_data_terminal_ready(false);
        let _ = port.write_request_to_send(false);

        // Vider le buffer RX pour ignorer les logs de boot firmware
        let _ = port.clear(serialport::ClearBuffer::Input);

        let reader_port = port.try_clone().map_err(|e| ConnectError::Other {
            port: port_name.to_string(),
            raw: format!("clone_failed: {}", e),
        })?;

        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        self.port = Some(port);
        self.connected_path = Some(port_name.to_string());
        self.stop_tx = Some(stop_tx);

        // F12: stocker le JoinHandle pour pouvoir join proprement
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
                        // F16: proteger contre les lignes trop longues
                        if line_buf.len() > MAX_LINE_LEN {
                            line_buf.clear();
                            continue;
                        }

                        let trimmed = line_buf.trim();
                        if trimmed.is_empty() {
                            continue;
                        }

                        // F2: parser le JSON HORS du lock pour minimiser la duree du lock
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

    /// Dispatch un message du device
    fn dispatch(&mut self, msg: DeviceMessage, channel: &Channel<SerialEvent>) {
        fn now_secs() -> f64 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs_f64()
        }

        /// Normalise un timestamp : si > 1e12 c'est en ms, on divise par 1000.
        fn normalize_ts(ts: f64) -> f64 {
            if ts > 1e12 { ts / 1000.0 } else { ts }
        }

        // T5 — Gating timestamps UTC. Sur LFT V1, le champ `ts` renvoyé par
        // le device est un UTC réel (RTC hardware + settimeofday au boot).
        // Sur legacy, c'est l'uptime depuis boot : on l'ignore et on
        // timestamppe à la réception PC.
        let use_device_ts = self.firmware_profile == Some(FirmwareProfile::LftV1);

        match msg {
            DeviceMessage::Packet {
                ts,
                rssi,
                snr,
                data,
                ..
            } => {
                let timestamp = if use_device_ts {
                    ts.map(normalize_ts).unwrap_or_else(now_secs)
                } else {
                    now_secs()
                };
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
                let ts_val = if use_device_ts {
                    ts.or(timestamp).map(normalize_ts).unwrap_or_else(now_secs)
                } else {
                    now_secs()
                };
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

                // Resoudre uniquement si la commande pendante est get_config
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
                // Stream get_events : les ack (begin et end) vont au collecteur.
                // Sur phase=end on dégage le collecteur pour que le prochain
                // get_events parte sur un état propre.
                if cmd == "get_events" && self.events_collector.is_some() {
                    if let Some(tx) = self.events_collector.as_ref() {
                        let _ = tx.send(Ok(msg.clone()));
                    }
                    if phase.as_deref() == Some("end") {
                        self.events_collector = None;
                    }
                    return;
                }

                // F8: on matche par nom de commande FIFO — c'est correct car les commandes
                // sont envoyees sequentiellement via send_command_safe (une seule a la fois).
                if let Some((_, expected_cmd, _)) = self.cmd_queue.front() {
                    if expected_cmd == cmd {
                        let (_, _, tx) = self.cmd_queue.pop_front().unwrap();
                        let _ = tx.send(Ok(msg.clone()));
                    }
                }
            }
            DeviceMessage::Error { ref cmd, .. } => {
                // Erreur firmware sur get_events : la relayer au collecteur si
                // actif, puis dégager. Sinon tomber dans le match cmd_queue.
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
                // Ligne de journal — uniquement pertinente pendant un stream
                // get_events. Hors stream (collector None), on ignore : un event
                // parasite ne doit pas polluer la cmd_queue.
                if let Some(tx) = self.events_collector.as_ref() {
                    let _ = tx.send(Ok(msg.clone()));
                }
            }
            DeviceMessage::Time { .. } => {
                // Réponse à `get_time` — on résout la commande pendante si elle
                // correspond. Pas d'event frontend : la valeur est consommée
                // directement par l'appelant (flow sync heure au connect).
                if let Some((_, expected_cmd, _)) = self.cmd_queue.front() {
                    if expected_cmd == "get_time" {
                        let (_, _, tx) = self.cmd_queue.pop_front().unwrap();
                        let _ = tx.send(Ok(msg.clone()));
                    }
                }
            }
        }
    }

    /// Prepare une commande : ecrit sur le port, enregistre le receiver.
    /// IMPORTANT : l'appelant doit dropper le MutexGuard AVANT d'appeler rx.recv_timeout().
    /// Retourne (cmd_id, Receiver) — l'ID permet un cleanup precis en cas de timeout.
    pub fn prepare_command(
        &mut self,
        cmd: SerialCommand,
    ) -> Result<(u64, mpsc::Receiver<Result<DeviceMessage, String>>), String> {
        if !INTERNAL_COMMANDS.contains(&cmd.cmd.as_str()) {
            return Err(format!("Commande inconnue: {}", cmd.cmd));
        }

        let port = self.port.as_mut().ok_or("Non connecte")?;

        let cmd_id = self.next_cmd_id;
        self.next_cmd_id += 1;

        let (tx, rx) = mpsc::channel();
        self.cmd_queue.push_back((cmd_id, cmd.cmd.clone(), tx));

        let json =
            serde_json::to_string(&cmd).map_err(|e| format!("Serialisation echouee: {}", e))?;

        port.write_all(format!("{}\n", json).as_bytes())
            .map_err(|e| format!("Ecriture echouee: {}", e))?;
        port.flush()
            .map_err(|e| format!("Flush echoue: {}", e))?;

        Ok((cmd_id, rx))
    }

    /// Envoie une commande et attend la reponse, avec retry optionnel.
    /// Lock le mutex pour ecrire, DROP le lock, puis attend la reponse.
    /// En cas de timeout + retries restants, attend 200ms et reessaie.
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

            // prepare_command peut échouer si le device n'est pas prêt
            // (ex. firmware en train de booter → "Ecriture echouee" os
            // error 121). Dans ce cas on retry comme pour un timeout :
            // c'est exactement le scénario où il faut insister.
            let (cmd_id, rx) = match {
                let mut mgr = lock_or_recover(state);
                mgr.prepare_command(cmd_clone)
            } {
                Ok(v) => v,
                Err(e) => {
                    if attempt < retries {
                        // Délai 1s : les write_err sont immédiats (driver USB
                        // qui rejette parce que device pas prêt), il faut
                        // explicitement laisser le temps au device de finir
                        // son init avant de retenter.
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
                        return Err(format!("Timeout commande: {}", cmd_name));
                    }
                }
            }
        }
        unreachable!()
    }

    /// Initie un stream `get_events` : installe un collecteur, écrit la
    /// commande sur le port, retourne le receiver. L'appelant lit ensuite :
    ///   1. ack phase=begin
    ///   2. N × Event
    ///   3. ack phase=end  → fin de stream
    /// Si l'appelant abandonne (timeout), il doit appeler `clear_events_collector`
    /// pour remettre le dispatcher en mode normal.
    pub fn prepare_events_stream(
        &mut self,
    ) -> Result<mpsc::Receiver<Result<DeviceMessage, String>>, String> {
        if self.events_collector.is_some() {
            return Err("Stream events déjà en cours".to_string());
        }
        let port = self.port.as_mut().ok_or("Non connecte")?;

        let (tx, rx) = mpsc::channel();
        self.events_collector = Some(tx);

        let json = r#"{"cmd":"get_events"}"#;
        port.write_all(format!("{}\n", json).as_bytes())
            .map_err(|e| {
                self.events_collector = None;
                format!("Ecriture echouee: {}", e)
            })?;
        port.flush().map_err(|e| {
            self.events_collector = None;
            format!("Flush echoue: {}", e)
        })?;

        Ok(rx)
    }

    /// Nettoyage à faire par l'appelant quand il sort de sa boucle de collecte
    /// (timeout, erreur). Inoffensif si le dispatcher a déjà fermé le collecteur
    /// sur ack phase=end.
    pub fn clear_events_collector(&mut self) {
        self.events_collector = None;
    }

    /// Envoie du JSON brut sur le port et attend la reponse.
    /// Utilise pour les commandes OTA qui ne rentrent pas dans SerialCommand.
    pub fn prepare_raw_command(
        &mut self,
        cmd_name: &str,
        json: &str,
    ) -> Result<(u64, mpsc::Receiver<Result<DeviceMessage, String>>), String> {
        let port = self.port.as_mut().ok_or("Non connecte")?;

        let cmd_id = self.next_cmd_id;
        self.next_cmd_id += 1;

        let (tx, rx) = mpsc::channel();
        self.cmd_queue.push_back((cmd_id, cmd_name.to_string(), tx));

        port.write_all(format!("{}\n", json).as_bytes())
            .map_err(|e| format!("Ecriture echouee: {}", e))?;
        port.flush()
            .map_err(|e| format!("Flush echoue: {}", e))?;

        Ok((cmd_id, rx))
    }

    /// Envoie une commande JSON brute et attend la reponse (lock-safe), avec retry optionnel.
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
                        return Err(format!("Timeout commande: {}", cmd_name));
                    }
                }
            }
        }
        unreachable!()
    }

    /// Ferme le port et arrete le thread reader (F6, F12)
    pub fn disconnect(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
        self.port = None;
        self.connected_path = None;
        self.config = None;
        self.drain_cmd_queue();

        // F12: attendre la fin du reader thread (avec timeout)
        if let Some(handle) = self.reader_handle.take() {
            // On ne bloque pas indefiniment — le reader a un timeout de 100ms
            // donc il sortira rapidement apres reception du stop signal
            let _ = handle.join();
        }
    }

    /// Cleanup interne (appele par le reader thread en cas de deconnexion)
    fn cleanup(&mut self) {
        self.stop_tx = None;
        self.port = None;
        self.connected_path = None;
        self.drain_cmd_queue();
        // On garde config et frames pour que le frontend puisse encore les afficher
        // Note: reader_handle sera None car le thread est en train de se terminer
    }

    /// Vide la queue de commandes pendantes.
    /// Envoie Err("Disconnected") a chaque Sender pour debloquer les recv_timeout.
    fn drain_cmd_queue(&mut self) {
        while let Some((_, _, tx)) = self.cmd_queue.pop_front() {
            let _ = tx.send(Err("Disconnected".to_string()));
        }
        // Si un stream events était en cours lors de la déco, on signale à
        // l'appelant via le drop du Sender : son recv_timeout retournera Err.
        if let Some(tx) = self.events_collector.take() {
            let _ = tx.send(Err("Disconnected".to_string()));
        }
    }
}
