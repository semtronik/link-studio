import { invoke, Channel } from '@tauri-apps/api/core';
import { useCallback, useRef, useState } from 'react';

// Mirrors the Rust types (serde rename_all = camelCase).
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
  kind: DeviceKind;
  product: string | null;
  model: string | null;
  version: string | null;
  mac: string | null;
}

export interface PortInfo {
  path: string; manufacturer: string; product: string;
  vid: string; pid: string; serialNumber: string; portType: string;
  // Set once the scanner's probe answered get_version.
  firmware?: PortFirmwareInfo | null;
  identifying?: boolean;
  // Held by another application: selection is blocked.
  busy?: boolean;
}

// From get_version. Only linkLr connects; lft is the prototype.
export type DeviceKind = 'linkLr' | 'lft' | 'unknown';

export interface FirmwareInfo {
  kind: DeviceKind;
  product: string | null;
  model: string | null;
  version: string | null;
  buildDate: string | null;
  mac: string | null;
}

export interface TimeSyncResult {
  wasInSync: boolean;
  driftS: number;
  wasInvalid: boolean;
  didSync: boolean;
}

// Raw firmware line, e.g. "2026-04-15T14:32:09Z CHARGE_START pct=34"; parsed in DiagnosticCard.
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
  // Held in a ref so the Channel is not garbage-collected.
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
          {
            // Silent and fire-and-forget: a failure is logged, never shown.
            const utc = Math.floor(Date.now() / 1000);
            const offsetMin = -new Date().getTimezoneOffset();
            invoke<TimeSyncResult>('sync_time', { utc, offsetMin })
              .then((r) => {
                if (r.didSync) {
                  console.info(
                    `[TIME] clock set (drift=${r.driftS.toFixed(1)}s, wasInvalid=${r.wasInvalid})`,
                  );
                } else {
                  console.info(`[TIME] already on time (drift=${r.driftS.toFixed(1)}s)`);
                }
              })
              .catch((e) => console.warn('[TIME] sync failed:', e));
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
      // Fails harmlessly if already disconnected.
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
    getValidParams,
    clearFrames, loadCapture,
    getFrames, getStats,
    getEvents,
    onFrame, setOnDisconnected,
    resetSource,
  };
}
