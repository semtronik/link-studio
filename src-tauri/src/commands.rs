use crate::firmware_manager;
use crate::lora_protocol::*;
use crate::port_scanner::{PortScanner, ScanPace};
use crate::serial_manager::{ConnectError, SerialManager};
use crate::{log_error, log_info, log_warn};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

/// RAII : marque le port comme "en cours d'ouverture" sur le SerialManager
/// le temps que `serial_connect` tourne. Le port_scanner skip ce path tant
/// que le guard existe, ce qui empêche une tentative d'ouverture parallèle
/// du même COM (Windows → os error 121). Le drop relâche le flag, même
/// en cas de panic ou de retour précoce.
///
/// À la création, si le scanner est en train de probe ce même port, on
/// attend (max 2.5 s) qu'il relâche le handle. Sans cette attente, les
/// deux ouvertures se chevauchent et `serial_connect` boucle sur os
/// error 121 jusqu'à ce que le probe termine de son côté.
struct ConnectingGuard {
    state: Arc<Mutex<SerialManager>>,
}

impl ConnectingGuard {
    fn new(
        state: Arc<Mutex<SerialManager>>,
        scanner: &PortScanner,
        port_name: &str,
    ) -> Self {
        // Attend que le scanner ait fini son probe ET que son délai post-probe
        // soit écoulé (le kernel Windows ne libère pas le handle instantanément
        // au Drop — le scanner tient `probing_path` jusqu'à ce que le handle
        // soit réellement libre).
        let waited = scanner
            .wait_probe_clear(port_name, std::time::Duration::from_millis(3000));
        if waited {
            log_info(&format!(
                "serial_connect: attendu fin probe sur {}",
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

/// SAFETY (F3): On utilise std::sync::Mutex (pas tokio::sync::Mutex) car toutes les
/// commandes Tauri sont synchrones (#[tauri::command] sans async). Le risque de deadlock
/// async n'existe pas. send_command_safe() garantit le pattern lock-write-drop-wait.
type SharedManager = Arc<Mutex<SerialManager>>;

/// Recupere le MutexGuard sans paniquer en cas de mutex empoisonne (F1).
fn lock_mgr(state: &SharedManager) -> Result<std::sync::MutexGuard<'_, SerialManager>, String> {
    state
        .lock()
        .map_err(|_| "Mutex empoisonne — redemarrez l'application".to_string())
}

/// Renvoie l'OS hôte sous forme de chaîne stable consommable côté frontend
/// (ex. pour adapter les messages d'erreur localisés selon la plateforme).
/// Valeurs : "windows" | "macos" | "linux" | "other".
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

    // RAII guard : attend la fin d'un éventuel probe en cours sur ce port,
    // puis marque le port "en cours d'ouverture". Garantit qu'aucun handle
    // concurrent ne traîne côté scanner au moment où on appelle `mgr.connect`.
    let _connecting_guard =
        ConnectingGuard::new(state.inner().clone(), scanner.inner(), &port_name);

    // Helper local : convertit une String d'erreur "secondaire" (lock,
    // get_config échoué, etc.) en ConnectError::Other, le code commun
    // pour les erreurs post-open. Le frontend les affichera via le
    // mapping standard.
    let other = |raw: String| ConnectError::Other {
        port: port_name.clone(),
        raw,
    };

    // Copie du channel pour envoyer l'event Firmware après identification.
    // La Channel Tauri est Clone — elle enregistre juste le même callback côté JS.
    let event_channel = on_event.clone();

    {
        let mut mgr = lock_mgr(state.inner()).map_err(&other)?;
        if let Err(e) = mgr.connect(&port_name, baud, on_event, state_clone) {
            log_error(&format!("Connect failed port={}: {}", port_name, e));
            return Err(e);
        }
    }

    // Délai de stabilisation après l'ouverture du port :
    //   - Le driver USB-série Windows peut continuer à émettre des
    //     pulses DTR/RTS pendant ~100 ms après l'ouverture
    //   - Le firmware ESP32 finit son init reader_thread + buffer flush
    // Sans ce délai, la première commande envoyée peut tomber dans la
    // fenêtre où le firmware n'est pas encore prêt à parser, et timeout.
    // Cohérent avec le délai déjà présent dans auto_setup après probe_port.
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Recuperer la config initiale. Retry agressif (6 tentatives) car
    // si l'utilisateur clique pour se connecter pendant que le firmware
    // est en cours de boot (cas typique : branchement USB juste avant le
    // clic), les premières écritures rejettent immédiatement avec
    // os error 121 ("device pas prêt"). Avec 1s de délai entre chaque,
    // on couvre ~6-7s de boot firmware avant d'abandonner.
    let cmd = SerialCommand {
        cmd: "get_config".to_string(),
        value: None,
    };
    let resp = match SerialManager::send_command_safe_with_retries(state.inner(), cmd, 6) {
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

    // --- Identification firmware (best-effort) ---
    // Le firmware legacy répond aussi à get_version mais sans product/model,
    // le profil sera alors Legacy. En cas de timeout (peu probable), on
    // suppose Legacy par défaut — aucune fonctionnalité V1 ne sera activée,
    // comportement sûr.
    let firmware_info = probe_firmware(state.inner());
    {
        let mut mgr = lock_mgr(state.inner()).map_err(&other)?;
        mgr.firmware_profile = Some(firmware_info.profile);
    }
    let _ = event_channel.send(SerialEvent::Firmware(firmware_info.clone()));

    log_info(&format!(
        "Connect port={} OK profile={:?} version={}",
        port_name,
        firmware_info.profile,
        firmware_info.version.as_deref().unwrap_or("?")
    ));

    // La sync heure est déclenchée côté React (besoin de l'offset local JS
    // qu'on n'a pas facilement en Rust sans dépendance chrono). Le frontend
    // appelle `sync_time` après avoir reçu l'event SerialEvent::Firmware si
    // profile == LftV1.

    Ok(config)
}

/// Récupère la version firmware et en déduit le profil. En cas d'échec
/// (timeout, réponse inattendue), retourne Legacy — fallback le plus sûr.
fn probe_firmware(state: &SharedManager) -> FirmwareInfo {
    let cmd = SerialCommand {
        cmd: "get_version".to_string(),
        value: None,
    };
    match SerialManager::send_command_safe_with_retries(state, cmd, 1) {
        Ok(DeviceMessage::Ack {
            version,
            build_date,
            product,
            model,
            mac,
            ..
        }) => {
            let profile = FirmwareProfile::from_version_ack(
                product.as_deref(),
                model.as_deref(),
            );
            FirmwareInfo {
                profile,
                product,
                model,
                version,
                build_date,
                mac,
            }
        }
        _ => FirmwareInfo {
            profile: FirmwareProfile::Legacy,
            product: None,
            model: None,
            version: None,
            build_date: None,
            mac: None,
        },
    }
}

/// Structure retournée par `sync_time` pour que React puisse afficher la
/// situation rencontrée (pour debug/log, pas forcément affiché à l'utilisateur).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TimeSyncResult {
    /// true si le LFT était déjà valide et à l'heure (pas de set_time envoyé).
    pub was_in_sync: bool,
    /// Dérive mesurée en secondes (device - pc). 0 si device pas valide.
    pub drift_s: f64,
    /// true si le device rapportait valid=false (RTC jamais configurée).
    pub was_invalid: bool,
    /// true si un set_time a été envoyé et ack.
    pub did_sync: bool,
}

/// Sync heure côté LFT V1. Appelé par React après identification firmware.
///
/// Paramètres:
/// - `utc`: epoch UTC actuel en secondes (Math.floor(Date.now()/1000) côté JS)
/// - `offset_min`: offset local PC en minutes (`-new Date().getTimezoneOffset()`)
///
/// Logique (Q2+Q3 validés utilisateur) :
/// - Si device `valid=false` (RTC pas configurée) : force la sync sans condition.
/// - Sinon si dérive > 30 s : sync silencieuse.
/// - Sinon : no-op.
///
/// Sécurité : rien ne se passe si profil != LftV1. Tout échec est silencieux.
#[tauri::command]
pub fn sync_time(
    state: State<'_, SharedManager>,
    utc: i64,
    offset_min: i32,
) -> Result<TimeSyncResult, String> {
    const DRIFT_THRESHOLD_S: f64 = 30.0;

    // Garde-fou : ne rien faire si pas LFT V1.
    {
        let mgr = lock_mgr(state.inner())?;
        if mgr.firmware_profile != Some(FirmwareProfile::LftV1) {
            return Ok(TimeSyncResult {
                was_in_sync: true,
                drift_s: 0.0,
                was_invalid: false,
                did_sync: false,
            });
        }
    }

    // 1) get_time
    let resp = SerialManager::send_command_safe(
        state.inner(),
        SerialCommand {
            cmd: "get_time".to_string(),
            value: None,
        },
    )?;

    let (device_utc, device_valid) = match resp {
        DeviceMessage::Time { utc, valid, .. } => (utc, valid.unwrap_or(false)),
        _ => return Err("Reponse inattendue a get_time".to_string()),
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

    // 2) set_time avec offset (JSON custom — SerialCommand ne supporte qu'une valeur)
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
            Err(format!("set_time rejeté: {}", msg))
        }
        _ => {
            log_error("Time sync: unexpected response");
            Err("set_time reponse inattendue".to_string())
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

/// F11: Validation basique des plages pour les commandes set_*.
/// La validation definitive est faite par le firmware (device-side backstop),
/// mais on rejette les valeurs manifestement incorrectes cote PC.
fn validate_command_value(cmd: &str, value: Option<f64>) -> Result<(), String> {
    let v = match value {
        Some(v) => v,
        None => return Ok(()), // pas de valeur a valider (ex: get_config)
    };

    match cmd {
        "set_freq" => {
            if !(150.0..=960.0).contains(&v) {
                return Err(format!("Frequence hors plage (150-960 MHz): {}", v));
            }
        }
        "set_sf" => {
            let sf = v as u8;
            if !SPREADING_FACTORS.contains(&sf) {
                return Err(format!("SF invalide (6-12): {}", v));
            }
        }
        "set_bw" => {
            if !VALID_BANDWIDTHS.contains(&v) {
                return Err(format!("Bandwidth invalide: {}", v));
            }
        }
        _ => {} // get_config, etc. — pas de validation necessaire
    }
    Ok(())
}

#[tauri::command]
pub fn send_command(
    state: State<'_, SharedManager>,
    cmd: String,
    value: Option<f64>,
) -> Result<serde_json::Value, String> {
    // Bloquer les commandes réservées aux flows internes (set_time / get_time
    // passent par sync_time, pas send_command).
    if !VALID_COMMANDS.contains(&cmd.as_str()) {
        return Err(format!("Commande non exposée au frontend: {}", cmd));
    }
    // F11: valider avant d'envoyer
    validate_command_value(&cmd, value)?;
    let command = SerialCommand { cmd, value };
    let response = SerialManager::send_command_safe(state.inner(), command)?;
    serde_json::to_value(&response).map_err(|e| format!("Serialisation reponse echouee: {}", e))
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
        mgr.config.clone().ok_or("Pas de config actuelle")?
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

    // Envoyer chaque commande via send_command_safe (hors du lock)
    // Best-effort : en cas d'echec partiel, refresh la config pour rester synchronise
    for cmd in &changes {
        let value_str = cmd.value.map(|v| format!("{}", v)).unwrap_or_default();
        let resp = match SerialManager::send_command_safe(state.inner(), cmd.clone()) {
            Ok(r) => r,
            Err(e) => {
                log_error(&format!("{} {} failed: {}", cmd.cmd, value_str, e));
                let _ = refresh_config_from_device(state.inner());
                return Err(format!("Erreur {}: {}", cmd.cmd, e));
            }
        };
        if let DeviceMessage::Error { msg, .. } = resp {
            log_warn(&format!("{} {} rejected: {}", cmd.cmd, value_str, msg));
            let _ = refresh_config_from_device(state.inner());
            return Err(format!("Erreur {}: {}", cmd.cmd, msg));
        }
        log_info(&format!("{} {} OK", cmd.cmd, value_str));
    }

    // Rafraichir la config depuis le device
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

/// F10: Auto-setup probe sequentiellement les ports — c'est intentionnel.
/// Le crate serialport est bloquant (pas d'API async), et chaque port doit etre
/// probe un par un car les ports serie ne supportent pas l'acces concurrent.
/// La commande Tauri est synchrone, l'UI affiche un spinner pendant le probing.
#[tauri::command]
pub fn auto_setup(
    state: State<'_, SharedManager>,
    on_event: Channel<SerialEvent>,
) -> Result<AutoSetupResult, String> {
    let ports =
        serialport::available_ports().map_err(|e| format!("Enumeration echouee: {}", e))?;

    let mut found_port: Option<String> = None;

    // Phase 1 : Probing leger — pas de reader thread
    for port_info in &ports {
        if probe_port(&port_info.port_name) {
            found_port = Some(port_info.port_name.clone());
            break;
        }
    }

    let port_name = found_port.ok_or("Aucun appareil detecte")?;

    // Windows USB-serial drivers need time to release the handle
    // after probe_port closes it.
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Phase 2 : Vrai connect sur le port trouve
    let state_clone = state.inner().clone();
    {
        let mut mgr = lock_mgr(state.inner())?;
        mgr.connect(&port_name, 115200, on_event, state_clone)
            .map_err(|e| e.to_string())?;
    }

    // Phase 3 : Appliquer config EU868 via send_command_safe
    let commands = vec![
        SerialCommand {
            cmd: "set_freq".to_string(),
            value: Some(868.1),
        },
        SerialCommand {
            cmd: "set_sf".to_string(),
            value: Some(7.0),
        },
        SerialCommand {
            cmd: "set_bw".to_string(),
            value: Some(125.0),
        },
    ];

    for cmd in commands {
        let resp = SerialManager::send_command_safe(state.inner(), cmd.clone())?;
        if let DeviceMessage::Error { msg, .. } = resp {
            let mut mgr = lock_mgr(state.inner())?;
            mgr.disconnect();
            return Err(format!("Auto-setup echoue sur {}: {}", cmd.cmd, msg));
        }
    }

    // Sync heure : déléguée au frontend React qui appellera `sync_time`
    // après identification firmware (besoin de l'offset local JS).

    // Recuperer config finale
    let resp = SerialManager::send_command_safe(
        state.inner(),
        SerialCommand {
            cmd: "get_config".to_string(),
            value: None,
        },
    )?;

    match resp {
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
            let mut mgr = lock_mgr(state.inner())?;
            mgr.config = Some(config.clone());
            Ok(AutoSetupResult {
                config,
                port: port_name,
            })
        }
        _ => Err("Config EU868 echouee".to_string()),
    }
}

// ============================================================
// Port scan — nouvelles commandes
//
// La logique de scan (énumération, probe, cache, diffusion) vit dans
// `port_scanner.rs`. Ici on expose juste les commandes Tauri que React
// appelle pour piloter le rythme et lire l'état courant. La diffusion
// des changements passe par l'event Tauri `ports_changed` (voir le
// module `port_scanner`).
// ============================================================

/// Snapshot synchrone de la dernière liste de ports connue (enrichie).
/// Utilisé au mount de React pour afficher l'état sans attendre un event.
#[tauri::command]
pub fn get_current_ports(scanner: State<'_, Arc<PortScanner>>) -> Vec<PortInfo> {
    scanner.current_ports()
}

/// Change le rythme de scan : `active=true` → 2 s (dropdown ouvert),
/// `active=false` → 5 s (veille). Réveille la boucle immédiatement.
#[tauri::command]
pub fn set_scan_pace(scanner: State<'_, Arc<PortScanner>>, active: bool) {
    let pace = if active { ScanPace::Active } else { ScanPace::Idle };
    scanner.set_pace(pace);
}

/// Force un scan immédiat sans attendre le prochain tick. Utile quand
/// l'utilisateur ouvre le dropdown pour rafraîchir l'identification
/// d'un port juste branché.
#[tauri::command]
pub fn refresh_ports_now(scanner: State<'_, Arc<PortScanner>>) {
    scanner.trigger_refresh();
}

/// Probe un port sans spawner de reader thread.
/// Lit jusqu'a 5 lignes pour tolerer les bannieres firmware (boot logs, etc.)
/// Verifie specifiquement que la reponse est un Config.
fn probe_port(port_name: &str) -> bool {
    let port = serialport::new(port_name, 115200)
        .timeout(std::time::Duration::from_millis(500))
        .open();

    let mut port = match port {
        Ok(p) => p,
        Err(_) => return false,
    };

    let cmd = r#"{"cmd":"get_config"}"#;
    if port
        .write_all(format!("{}\n", cmd).as_bytes())
        .is_err()
    {
        return false;
    }
    let _ = port.flush();

    let mut reader = std::io::BufReader::new(&mut port);
    for _ in 0..5 {
        let mut line = String::new();
        match std::io::BufRead::read_line(&mut reader, &mut line) {
            Ok(n) if n > 0 => {
                if let Ok(DeviceMessage::Config { .. }) =
                    serde_json::from_str::<DeviceMessage>(line.trim())
                {
                    return true;
                }
            }
            _ => return false,
        }
    }
    false
}

/// Rafraichit la config depuis le device apres echec partiel.
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
            // Normaliser timestamp : si > 1e12 c'est en ms, sinon en secondes
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

/// Retourne la version firmware du device connecte, ou null si non supporte.
#[tauri::command]
pub fn get_device_version(
    state: State<'_, SharedManager>,
) -> Result<Option<String>, String> {
    let is_connected = {
        let mgr = lock_mgr(state.inner())?;
        mgr.is_connected()
    };
    if !is_connected {
        return Err("Non connecte".to_string());
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
        .map_err(|e| format!("Lecture firmware echouee: {}", e))?;
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
        return Err(format!("ota_begin echoue: {}", msg));
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
            return Err(format!("ota_data echoue (chunk {}): {}", seq, msg));
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
        return Err(format!("ota_end echoue: {}", msg));
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

/// Récupère le journal système stocké par le firmware.
///
/// Envoie `{"cmd":"get_events"}` et collecte le stream :
///   1. `{"type":"ack","cmd":"get_events","phase":"begin"}`
///   2. N × `{"type":"event","line":"...","seq":N}`
///   3. `{"type":"ack","cmd":"get_events","phase":"end","count":N}`
///
/// Retourne la liste ordonnée des lignes de log. Le parsing timestamp /
/// event / details est laissé au frontend pour flexibilité d'affichage.
///
/// Timeouts : 5 s entre chaque message reçu. Un log complet de 800 lignes
/// passe largement dans cette fenêtre (streamer lent : 1 ligne = quelques
/// ms côté firmware). Sur timeout ou erreur, le collecteur est nettoyé
/// pour ne pas bloquer une future commande.
#[tauri::command]
pub fn get_events(state: State<'_, SharedManager>) -> Result<Vec<EventLogEntry>, String> {
    use std::time::Duration;
    const INTER_MSG_TIMEOUT: Duration = Duration::from_secs(5);
    const HARD_CAP_ENTRIES: usize = 5000; // garde-fou stream runaway

    // Installe le collecteur et envoie la commande (lock court).
    let rx = {
        let mut mgr = lock_mgr(state.inner())?;
        mgr.prepare_events_stream()?
    };

    let mut entries: Vec<EventLogEntry> = Vec::new();
    let mut got_begin = false;

    // Helper local de cleanup. State est capturé par référence (pas de move
    // dans une closure — évite les soucis de type inference sur SharedManager).
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
                        // Le dispatcher a déjà remis le collector à None.
                        return Ok(entries);
                    }
                    _ => {
                        // Ack sans phase attendue — on ignore mais on continue.
                    }
                }
            }
            Ok(Ok(DeviceMessage::Event { line, seq })) => {
                if !got_begin {
                    // Event avant begin : format firmware cassé. On tolère
                    // mais on log pour diag.
                    eprintln!("[get_events] event reçu avant ack begin");
                }
                entries.push(EventLogEntry {
                    line,
                    seq: seq.unwrap_or(entries.len() as u32),
                });
                if entries.len() >= HARD_CAP_ENTRIES {
                    cleanup_collector(state.inner());
                    return Err(format!(
                        "Stream trop long ({} events) — firmware cassé ?",
                        HARD_CAP_ENTRIES
                    ));
                }
            }
            Ok(Ok(DeviceMessage::Error { msg, .. })) => {
                cleanup_collector(state.inner());
                return Err(format!("Firmware rejette get_events: {}", msg));
            }
            Ok(Ok(_)) => {
                // Autre message inattendu — on ignore silencieusement.
            }
            Ok(Err(e)) => {
                cleanup_collector(state.inner());
                return Err(format!("Stream interrompu: {}", e));
            }
            Err(_) => {
                cleanup_collector(state.inner());
                return Err(format!(
                    "Timeout stream events (aucun message reçu depuis {}s)",
                    INTER_MSG_TIMEOUT.as_secs()
                ));
            }
        }
    }
}
