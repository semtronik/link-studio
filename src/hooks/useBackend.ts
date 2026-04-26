import { invoke, Channel } from '@tauri-apps/api/core';
import { useCallback, useRef, useState } from 'react';

// Types miroir du Rust (les champs matchent le JSON serialise par serde rename_all camelCase)
export interface LoRaConfig {
  freq: number; sf: number; bw: number; drops: number;
}
export interface FrameData {
  id: string; type: string; hex: string; timestamp: number; rssi: number | null; snr: number | null;
}
export interface FrameStats {
  count: number; avgRssi: number | null; avgSnr: number | null;
}
export interface PortFirmwareInfo {
  profile: FirmwareProfile;
  product: string | null;
  model: string | null;
  version: string | null;
  mac: string | null;
}

export interface PortInfo {
  path: string; manufacturer: string; product: string;
  vid: string; pid: string; serialNumber: string; portType: string;
  // Enrichissement via le scanner Rust après identification firmware.
  // Présent uniquement pour les ports identifiés comme LFT (V1 ou legacy).
  firmware?: PortFirmwareInfo | null;
  // True tant que le scanner est en train d'identifier ce port (candidat
  // VID Espressif, encore en phase Retrying). L'UI affiche un spinner à
  // la place du label générique VID/PID le temps que le probe aboutisse.
  identifying?: boolean;
  // True si le port est monopolisé par une autre application (Arduino IDE,
  // moniteur série, PuTTY...). L'UI bloque la sélection et affiche un
  // label dédié — un connect échouerait de toute façon tant que l'autre
  // appli tient le handle.
  busy?: boolean;
}

// Profil firmware identifié au connect via la commande get_version.
// lftV1 : firmware LFT V1+ (product="LFT", model="v1"). Supporte sync heure,
// timestamps UTC des trames, enregistrement futur.
// legacy : firmware DevKit V0. Pas de réglage heure, timestamps PC à l'arrivée.
export type FirmwareProfile = 'lftV1' | 'legacy';

export interface FirmwareInfo {
  profile: FirmwareProfile;
  product: string | null;
  model: string | null;
  version: string | null;
  buildDate: string | null;
  mac: string | null;
}

// Résultat retourné par la commande Tauri sync_time (pour debug/toast éventuel).
export interface TimeSyncResult {
  wasInSync: boolean;
  driftS: number;
  wasInvalid: boolean;
  didSync: boolean;
}

// Entrée de journal système (get_events). Le `line` est la ligne brute
// écrite par le firmware (ex: "2026-04-15T14:32:09Z CHARGE_START pct=34").
// Le parsing timestamp/event/details est fait côté UI dans DiagnosticCard.
export interface EventLogEntry {
  line: string;
  seq: number;
}

type SerialEvent =
  | { event: 'frame'; data: FrameData }
  | { event: 'config'; data: LoRaConfig }
  | { event: 'stats'; data: FrameStats }
  | { event: 'firmware'; data: FirmwareInfo }
  | { event: 'disconnected' };

export type DataSource = 'live' | 'replay' | null;

export function useBackend() {
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<LoRaConfig | null>(null);
  const [stats, setStats] = useState<FrameStats>({ count: 0, avgRssi: null, avgSnr: null });
  const [dataSource, setDataSource] = useState<DataSource>(null);
  const [currentPort, setCurrentPort] = useState<string | null>(null);
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const frameCallbackRef = useRef<((frame: FrameData) => void) | null>(null);
  const onDisconnectedRef = useRef<(() => void) | null>(null);
  // F5: persister le Channel dans un ref pour eviter le GC JS
  const channelRef = useRef<Channel<SerialEvent> | null>(null);

  const createChannel = useCallback((): Channel<SerialEvent> => {
    const channel = new Channel<SerialEvent>();
    channel.onmessage = (event) => {
      switch (event.event) {
        case 'frame':
          frameCallbackRef.current?.(event.data);
          break;
        case 'config':
          setConfig(event.data);
          break;
        case 'stats':
          setStats(event.data);
          break;
        case 'firmware':
          setFirmware(event.data);
          // Sync heure automatique sur LFT V1 uniquement (pas de dialogue,
          // silencieuse : choix Q1 utilisateur). Fire-and-forget pour ne pas
          // bloquer l'UI, tout échec est loggé mais non remonté.
          if (event.data.profile === 'lftV1') {
            const utc = Math.floor(Date.now() / 1000);
            const offsetMin = -new Date().getTimezoneOffset();
            invoke<TimeSyncResult>('sync_time', { utc, offsetMin })
              .then((r) => {
                if (r.didSync) {
                  console.info(
                    `[TIME] sync appliquée (drift=${r.driftS.toFixed(1)}s, wasInvalid=${r.wasInvalid})`,
                  );
                } else {
                  console.info(`[TIME] déjà à l'heure (drift=${r.driftS.toFixed(1)}s)`);
                }
              })
              .catch((e) => console.warn('[TIME] sync échouée:', e));
          }
          break;
        case 'disconnected':
          setConnected(false);
          setCurrentPort(null);
          setDataSource(null);
          setFirmware(null);
          onDisconnectedRef.current?.();
          break;
      }
    };
    // F5: stocker dans le ref pour empecher le GC
    channelRef.current = channel;
    return channel;
  }, []);

  const connect = useCallback(async (portName: string): Promise<LoRaConfig> => {
    setLoading(true);
    try {
      const channel = createChannel();

      const cfg = await invoke<LoRaConfig>('serial_connect', {
        portName,
        onEvent: channel,
      });
      setConnected(true);
      setCurrentPort(portName);
      setDataSource('live');
      setConfig(cfg);
      return cfg;
    } finally {
      setLoading(false);
    }
  }, [createChannel]);

  const disconnect = useCallback(async () => {
    try {
      await invoke('serial_disconnect');
    } catch (e) {
      // F6: log mais ne pas bloquer — le disconnect peut echouer si deja deconnecte
      console.warn('[useBackend] disconnect error:', e);
    }
    channelRef.current = null;
    setConnected(false);
    setConfig(null);
    setCurrentPort(null);
    setDataSource(null);
    setFirmware(null);
    setStats({ count: 0, avgRssi: null, avgSnr: null });
  }, []);

  const applyConfig = useCallback(async (params: Partial<LoRaConfig>): Promise<LoRaConfig> => {
    const cfg = await invoke<LoRaConfig>('apply_config', params);
    setConfig(cfg);
    return cfg;
  }, []);

  const sendCommand = useCallback(async (cmd: string, value?: number) => {
    return invoke('send_command', { cmd, value });
  }, []);

  const autoSetup = useCallback(async (): Promise<LoRaConfig> => {
    setLoading(true);
    try {
      const channel = createChannel();
      const result = await invoke<{ config: LoRaConfig; port: string }>('auto_setup', { onEvent: channel });
      setConnected(true);
      setDataSource('live');
      setCurrentPort(result.port);
      setConfig(result.config);
      return result.config;
    } finally {
      setLoading(false);
    }
  }, [createChannel]);

  const getValidParams = useCallback(async () => {
    return invoke<{ bandwidths: number[]; spreadingFactors: number[] }>('get_valid_params');
  }, []);

  const clearFrames = useCallback(async () => {
    await invoke('clear_frames');
    setStats({ count: 0, avgRssi: null, avgSnr: null });
  }, []);

  const loadCapture = useCallback(async (
    captureConfig: LoRaConfig | null,
    frames: any[],
  ): Promise<FrameData[]> => {
    setLoading(true);
    try {
      const result = await invoke<FrameData[]>('load_capture', { config: captureConfig, frames });
      if (captureConfig) setConfig(captureConfig);
      setDataSource('replay');
      setCurrentPort(null);
      return result;
    } finally {
      setLoading(false);
    }
  }, []);

  const getFrames = useCallback(async (): Promise<FrameData[]> => {
    return invoke<FrameData[]>('get_frames');
  }, []);

  const getStats = useCallback(async (): Promise<FrameStats> => {
    return invoke<FrameStats>('get_stats');
  }, []);

  const getEvents = useCallback(async (): Promise<EventLogEntry[]> => {
    return invoke<EventLogEntry[]>('get_events');
  }, []);

  const onFrame = useCallback((cb: (frame: FrameData) => void) => {
    frameCallbackRef.current = cb;
    return () => { frameCallbackRef.current = null; };
  }, []);

  const setOnDisconnected = useCallback((cb: (() => void) | null) => {
    onDisconnectedRef.current = cb;
  }, []);

  const resetSource = useCallback(() => {
    setDataSource(null);
    setCurrentPort(null);
    setConfig(null);
    setStats({ count: 0, avgRssi: null, avgSnr: null });
  }, []);

  return {
    connected, config, stats,
    dataSource, currentPort, firmware, loading,
    connect, disconnect,
    applyConfig, sendCommand,
    autoSetup, getValidParams,
    clearFrames, loadCapture,
    getFrames, getStats,
    getEvents,
    onFrame, setOnDisconnected,
    resetSource,
  };
}
