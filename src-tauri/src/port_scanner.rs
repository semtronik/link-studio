//! Boucle de scan des ports série côté Rust — source unique de vérité.
//!
//! Principe :
//!   1. Tâche de fond (thread) qui tourne tant que l'app vit.
//!   2. À chaque tick, énumère les ports, filtre par VID connu, probe les
//!      nouveaux (VID Espressif) via `get_version`, émet `ports_changed`
//!      si la liste enrichie change.
//!   3. Le rythme (pace) est piloté par le frontend via `set_scan_pace` :
//!      `Active` (dropdown ouvert) = 2 s, `Idle` (dropdown fermé) = 5 s.
//!   4. Coordination avec `serial_connect` : on skip le probe du port que
//!      le SerialManager déclare `busy_path` (connecté OU en cours de
//!      connexion), pour ne pas tenter deux ouvertures concurrentes du
//!      même COM (Windows → os error 121).
//!
//! Aucune commande Tauri n'a besoin d'ouvrir le port pour lister : le
//! scanner en continu émet l'état enrichi, React s'abonne via `listen`.

use crate::lora_protocol::{
    DeviceMessage, FirmwareProfile, PortFirmwareInfo, PortInfo,
};
use crate::serial_manager::SerialManager;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const EVENT_PORTS_CHANGED: &str = "ports_changed";

/// Rythme du scan. Passé à `Active` quand l'UI a besoin de réactivité
/// (dropdown ouvert), `Idle` sinon.
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

/// Payload émis au frontend quand la liste change. `scanning` passe à true
/// pendant qu'un probe est en cours (les ports connus restent visibles,
/// l'UI peut afficher un spinner).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortsChangedEvent {
    pub ports: Vec<PortInfo>,
    pub scanning: bool,
}

/// État partagé entre la boucle et les commandes Tauri. Le Condvar permet
/// à `set_scan_pace` et `refresh_now` de réveiller la boucle immédiatement
/// plutôt que d'attendre la fin de l'intervalle courant.
pub struct ScannerState {
    pace: ScanPace,
    /// Ports actuellement connus (enrichis). Expose `get_current_ports`
    /// sans avoir à refaire un scan.
    last_ports: Vec<PortInfo>,
    /// Timestamp du dernier scan complet. Permet `refresh_now` à la demande.
    force_refresh: bool,
    /// Path du port que le scanner est en train de probe physiquement
    /// (port ouvert, `get_version` envoyé, en attente de réponse). Utilisé
    /// par `ConnectingGuard` pour attendre la fin du probe avant d'ouvrir
    /// le même port côté `serial_connect` — sans ça, les deux ouvertures
    /// concurrentes se marchent dessus sous Windows (os error 121).
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

    /// Snapshot des ports actuellement connus (sans déclencher de scan).
    pub fn current_ports(&self) -> Vec<PortInfo> {
        let (lock, _) = &*self.state;
        let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        guard.last_ports.clone()
    }

    /// Change le rythme de scan et réveille la boucle si elle dort.
    pub fn set_pace(&self, pace: ScanPace) {
        let (lock, cvar) = &*self.state;
        let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        guard.pace = pace;
        cvar.notify_all();
    }

    /// Force un scan immédiat (utile quand l'utilisateur ouvre le dropdown
    /// pour ne pas attendre le prochain tick).
    pub fn trigger_refresh(&self) {
        let (lock, cvar) = &*self.state;
        let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        guard.force_refresh = true;
        cvar.notify_all();
    }

    /// Attend qu'aucun probe ne soit en cours sur `path`. Utilisé par
    /// `serial_connect` avant d'ouvrir le port, pour éviter le conflit
    /// d'ouverture concurrente avec le scanner (Windows os error 121).
    ///
    /// Poll toutes les 50 ms, plafonné à `max` (typiquement 2.5 s — le
    /// probe lui-même est capé à 2 s). Au-delà, on rend la main : le
    /// scanner doit gérer son propre cas, on ne bloque pas l'UX.
    ///
    /// Retourne `true` si un probe était actif et qu'on a effectivement
    /// attendu (même une seule itération), `false` si le path était déjà
    /// libre au premier coup d'œil. L'appelant utilise ce retour pour
    /// décider d'un délai de grâce post-probe (le driver USB-CDC et le
    /// firmware ont besoin de ~500 ms pour se calmer entre une fermeture
    /// et la réouverture — sans ça, les premières écritures se prennent
    /// des os error 121).
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

    /// Spawn la boucle de scan. Ne retourne jamais (tourne jusqu'à l'arrêt
    /// de l'app). Passé dans un `std::thread::spawn` au setup Tauri.
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

/// Boucle principale du scanner. `probe_cache` est local à la boucle — un
/// seul thread y accède, pas de Mutex nécessaire.
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

        // Diffusion si la liste a changé
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

        // Attendre le prochain tick (ou réveil anticipé via Condvar)
        // Intervalle d'attente : tant qu'un port est en cours d'identification
        // (`Retrying`), on tick plus vite pour coller au boot firmware. Sinon
        // on suit le pace nominal (Active/Idle) piloté par l'UI.
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

/// Réalise une passe : énumération, filtrage, probe des candidats non
/// cachés. Retourne la liste enrichie et un flag `scanning` (toujours
/// false en sortie — le spinner côté UI se pilote via `trigger_refresh`
/// si on veut l'afficher pendant le scan, pas encore implémenté).
/// Enrichit une liste énumérée sans ouvrir aucun port : on ne fait que
/// rapatrier le firmware des ports déjà identifiés (`Success`) depuis le
/// cache. Utilisé pendant le gel du scanner (session série active), où
/// tout probe est interdit pour ne pas entrer en collision avec une autre
/// application. Les ports inconnus restent tels quels (non identifiés).
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
            crate::log_warn(&format!("port_scanner: énumération échouée: {}", e));
            return (Vec::new(), false);
        }
    };

    // Purge les entrées de cache dont la clé (vid:pid:serial) n'est plus
    // présente dans l'énumération courante. Ça couvre tous les cas de
    // déconnexion :
    //   - LFT qu'on débranche : `Success` dégagé. Au re-branchement, on
    //     re-probe — essentiel car le firmware re-boot et ne répond pas
    //     tant que son init radio n'est pas finie (on ne veut pas afficher
    //     "LFT V1" depuis l'ancien cache et laisser l'utilisateur cliquer
    //     sur un firmware pas prêt → os error 121 au connect).
    //   - Port `Retrying` arraché : compteur remis à zéro au re-branchement.
    //   - Port `Failure Busy` arraché : l'autre appli n'a plus le port
    //     depuis qu'il est physiquement absent, on ne garde pas l'info.
    {
        let present: std::collections::HashSet<String> =
            ports.iter().map(cache_key).collect();
        cache.retain(|k, _| present.contains(k));
    }

    // Gel des probes tant qu'une session série est active. Dès que le
    // SerialManager est connecté (ou en cours de connexion) à un device,
    // `busy_path()` est `Some` : on n'a plus besoin de chercher d'autres
    // ports, et surtout on ne doit ouvrir AUCUN port — sinon le scanner
    // entre en collision avec une autre application qui flashe un second
    // ESP (esptool ouvre le port par à-coups, os error 121 des deux côtés).
    //
    // On continue malgré tout d'énumérer (métadonnées USB, sans ouverture)
    // pour que le dropdown reste vivant : un device branché pendant la
    // session apparaît, simplement sans identification firmware (on ne
    // peut pas la faire sans ouvrir le port). Les ports déjà identifiés
    // avant la connexion restent étiquetés via le cache `Success`.
    //
    // Le dégel est automatique : à la déconnexion (volontaire ou perte
    // physique), `busy_path()` repasse à `None` et le scan reprend au tick
    // suivant — pas de wiring supplémentaire côté `serial_disconnect`.
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

        // Lecture cache. Trois états possibles :
        //   Success : on a déjà identifié, on réutilise (permanent session).
        //   Retrying : on a déjà essayé au moins une fois sans succès.
        //              On ne retente que si `PROBE_RETRY_DELAY` écoulé depuis
        //              la dernière tentative.
        //   Failure : échec définitif, on skip jusqu'à expiration.
        match cache.get(&key).cloned() {
            Some(ProbeCacheEntry::Success(info)) => {
                port.firmware = Some(info);
                enriched.push(port);
                continue;
            }
            Some(ProbeCacheEntry::Retrying { last_attempt, .. })
                if now.duration_since(last_attempt) < PROBE_RETRY_DELAY =>
            {
                // Trop tôt pour retenter, on laisse tel quel mais on signale
                // à l'UI qu'on est en cours d'identification (spinner).
                port.identifying = true;
                has_identifying = true;
                enriched.push(port);
                continue;
            }
            Some(ProbeCacheEntry::Failure { until, reason }) if until > now => {
                // Tant que le cache est chaud, on ré-émet le statut sans
                // rouvrir le port. Pour `Busy`, c'est important : l'UI doit
                // continuer à montrer "Utilisé par une autre application"
                // à chaque tick.
                if reason == FailureReason::Busy {
                    port.busy = true;
                }
                enriched.push(port);
                continue;
            }
            Some(ProbeCacheEntry::Failure { .. }) => {
                // TTL Failure écoulé, on retente à zéro.
                cache.remove(&key);
            }
            _ => {}
        }

        // Skip si le port est utilisé par l'app (connect ou en cours).
        let busy_now = {
            let guard = serial.lock().unwrap_or_else(|p| p.into_inner());
            guard.busy_path().map(|s| s.to_string())
        };
        if busy_now.as_deref() == Some(port.path.as_str()) {
            enriched.push(port);
            continue;
        }

        // Annonce qu'on ouvre ce port pour que `ConnectingGuard` puisse
        // attendre sa libération avant d'ouvrir le même port côté connect.
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
                    "port_scanner: {} identifié: {:?} v{}",
                    port.path,
                    info.profile,
                    info.version.as_deref().unwrap_or("?")
                ));
                cache.insert(key, ProbeCacheEntry::Success(info.clone()));
                port.firmware = Some(info);
            }
            ProbeOutcome::OpenFailed => {
                // Port monopolisé par autre appli (ou disparu pile maintenant).
                // Cache long, inutile de spammer. On marque le port `busy`
                // pour que l'UI affiche un label dédié plutôt que le VID/PID
                // générique — l'utilisateur comprend tout de suite pourquoi
                // il ne peut pas s'y connecter.
                crate::log_warn(&format!(
                    "port_scanner: {} open échoué (occupé?), cache Failure {}s",
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
                // Firmware pas encore prêt (hot-plug : init Wio-E5 qui peut
                // prendre jusqu'à ~16 s avant que get_version soit traité).
                // On retente jusqu'à PROBE_MAX_ATTEMPTS fois avant d'abandonner.
                let prev_attempts = match cache.get(&key) {
                    Some(ProbeCacheEntry::Retrying { attempts, .. }) => *attempts,
                    _ => 0,
                };
                let attempts = prev_attempts + 1;
                if attempts >= PROBE_MAX_ATTEMPTS {
                    crate::log_warn(&format!(
                        "port_scanner: {} silencieux après {} tentatives, cache Failure {}s",
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
                        "port_scanner: {} pas de réponse (tentative {}/{}), retry dans {}ms",
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

/// Deux listes sont égales si mêmes paths + mêmes flags d'état visibles
/// à l'UI (`identifying`, `busy`, `firmware`). Les autres champs
/// (manufacturer, product, etc.) sont stables pour un device donné — on
/// les ignore pour éviter les faux positifs qui feraient re-render l'UI
/// sans changement perceptible.
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
            x.profile == y.profile
                && x.product == y.product
                && x.model == y.model
                && x.version == y.version
        }
        _ => false,
    }
}

// ============================================================
// Énumération + filtrage (déplacés depuis commands.rs)
// ============================================================

fn list_ports_filtered() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports()
        .map_err(|e| format!("Enumeration ports echouee: {}", e))?;

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

/// VID candidat au probe (Espressif uniquement — seul à parler le protocole LFT).
fn is_candidate_vid(vid: &str) -> bool {
    vid.eq_ignore_ascii_case("303A")
}

/// VID affichés dans la liste (bridges série connus). Filtre les ports
/// Bluetooth/PCI/etc. qui ne peuvent pas porter un LFT.
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
// Cache probe (déplacé depuis commands.rs)
// ============================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FailureReason {
    /// Port monopolisé par une autre application : open échoue immédiatement.
    Busy,
    /// Firmware ne répond pas après `PROBE_MAX_ATTEMPTS`. Probablement pas un LFT.
    Unresponsive,
}

#[derive(Clone)]
enum ProbeCacheEntry {
    /// Identification réussie, conservée pour toute la session (un LFT qui
    /// répond à un moment répondra au suivant — on ne re-probe jamais).
    Success(PortFirmwareInfo),
    /// Pas encore identifié. `attempts` compte les `NoResponse` consécutifs,
    /// `last_attempt` permet d'espacer les tentatives via `PROBE_RETRY_DELAY`.
    /// Quand `attempts` atteint `PROBE_MAX_ATTEMPTS`, bascule en `Failure`.
    Retrying { attempts: u32, last_attempt: Instant },
    /// Échec définitif (port monopolisé ou `NoResponse` épuisé). Cache long
    /// pour ne pas spammer un port qui ne va visiblement pas répondre. La
    /// raison permet à l'UI de différencier "busy" (affichage dédié) d'un
    /// port qui a juste refusé de parler (on le laisse en générique).
    Failure { until: Instant, reason: FailureReason },
}

/// Cache un échec "définitif" pendant 15 s. Pertinent dans deux cas :
///   1. Port monopolisé par une autre application (Arduino IDE, PuTTY, …) :
///      ouvrir le port échoue instantanément, inutile d'insister chaque tick.
///      15 s laisse une fenêtre courte pour détecter la libération.
///   2. Max tentatives `NoResponse` épuisées : si un port candidat VID 303A
///      n'a pas répondu après `PROBE_MAX_ATTEMPTS` passages espacés de
///      `PROBE_RETRY_DELAY`, ce n'est probablement pas un LFT, on se calme.
const PROBE_FAILURE_TTL: Duration = Duration::from_secs(15);

/// Timeout de la fenêtre d'écoute dans `probe_port_firmware`. Court
/// volontairement : un LFT prêt répond en quelques ms, on n'a pas besoin
/// d'attendre. Au hot-plug (firmware pas prêt), c'est le retry qui couvre
/// le boot via plusieurs tentatives rapprochées.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Nombre de tentatives `NoResponse` consécutives avant de passer en cache
/// Failure long. Avec `PROBE_RETRY_DELAY` 500 ms et un timeout de 2 s, on
/// couvre une fenêtre de ~40 s — largement au-delà de l'init complète du
/// firmware LFT (vu en test à ~16 s pour le get_version qui n'est dispo
/// qu'après init radio).
const PROBE_MAX_ATTEMPTS: u32 = 15;

/// Délai minimal entre deux tentatives `NoResponse` sur le même port. Court
/// pour coller au plus près du boot firmware : quand celui-ci bascule en
/// "prêt", on l'identifie sans latence superflue.
const PROBE_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Intervalle d'attente entre deux ticks tant qu'au moins un port est en
/// cours d'identification (`Retrying`). Quand tous les ports sont tranchés,
/// on retombe sur le pace nominal (Active/Idle). Évite d'attendre 2-5 s
/// entre deux tentatives alors que le firmware est peut-être prêt.
const IDENTIFYING_TICK: Duration = Duration::from_millis(500);

/// Résultat d'un probe, permettant de différencier un port monopolisé
/// (fermé d'office par l'OS) d'un port ouvert mais silencieux (firmware
/// pas encore prêt). Les deux se cachent différemment.
#[derive(Debug)]
enum ProbeOutcome {
    Identified(PortFirmwareInfo),
    OpenFailed,
    NoResponse,
}

fn cache_key(port: &PortInfo) -> String {
    format!("{}:{}:{}", port.vid, port.pid, port.serial_number)
}

/// Probe un port : ouvre, désactive DTR/RTS, envoie get_version, lit jusqu'à
/// `PROBE_TIMEOUT`. Distingue trois issues :
///   - `Identified` : firmware LFT a répondu, on a l'info.
///   - `OpenFailed` : port monopolisé par une autre app ou disparu — l'open
///     a échoué immédiatement, inutile d'insister.
///   - `NoResponse` : port ouvert mais silencieux (firmware pas encore prêt
///     sur hot-plug, device inconnu, etc.).
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
                        let profile = FirmwareProfile::from_version_ack(
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
                            profile,
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
            profile: FirmwareProfile::LftV1,
            product: Some("LFT".into()),
            model: Some("v1".into()),
            version: Some("0.2.3".into()),
            mac: None,
        });
        assert!(!ports_equal(&[a.clone()], &[b.clone()]));
        assert!(ports_equal(&[a.clone()], &[a.clone()]));
        assert!(ports_equal(&[b.clone()], &[b.clone()]));
    }

    #[test]
    fn ports_equal_ignores_product_label() {
        // Un changement de `product` côté driver OS ne compte pas comme
        // un changement — seul path + firmware + identifying comptent. Évite
        // les emits parasites quand Windows reformate la chaîne USB descriptor.
        let a = make_port();
        let mut b = a.clone();
        b.product = "P2".into();
        assert!(ports_equal(&[a], &[b]));
    }

    #[test]
    fn ports_equal_detects_identifying_change() {
        // Quand le flag identifying bascule (Retrying → Success/Failure),
        // l'UI doit être notifiée pour retirer/afficher le spinner.
        let a = make_port();
        let mut b = a.clone();
        b.identifying = true;
        assert!(!ports_equal(&[a], &[b]));
    }

    #[test]
    fn ports_equal_detects_busy_change() {
        // Quand le flag busy bascule (port libéré par l'autre app après
        // expiration du cache Failure), l'UI doit retirer le label
        // "Utilisé par une autre application".
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
        // Session active (scanner gelé) : un port déjà identifié doit
        // ressortir avec son firmware repris du cache `Success`, sans
        // qu'aucune ouverture de port ne soit nécessaire.
        let port = make_port();
        let info = PortFirmwareInfo {
            profile: FirmwareProfile::LftV1,
            product: Some("LFT".into()),
            model: Some("v1".into()),
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
        // Pendant le gel, un port absent du cache (jamais identifié, ou
        // en `Retrying`/`Failure`) ressort tel quel : pas de firmware, pas
        // de flag modifié — on ne l'ouvre pas pour l'identifier.
        let port = make_port();
        let cache = HashMap::new();
        let out = enrich_from_cache_only(vec![port.clone()], &cache);
        assert_eq!(out.len(), 1);
        assert!(out[0].firmware.is_none());
        assert_eq!(out[0].path, port.path);
    }

    #[test]
    fn busy_path_drives_freeze_decision() {
        // Le gel est piloté par `busy_path()` du SerialManager : `None`
        // quand libre (scan normal), `Some` dès qu'on amorce une connexion
        // (gel). Garantit que le scanner cesse tout probe en session.
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
