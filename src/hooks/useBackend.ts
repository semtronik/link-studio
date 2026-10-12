import { invoke, Channel } from '@tauri-apps/api/core';
import { useCallback, useRef, useState } from 'react';
import type { Profile, RecordLine, SessionInfo } from '../types/recording';
import { profileOf } from '../utils/journal';

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
  driftS: number;
  wasInvalid: boolean;
  didSync: boolean;
}

interface ConnectInfo {
  firmware: FirmwareInfo;
  profile: Profile;
  clock: TimeSyncResult;
}

// Raw firmware line, e.g. "2026-04-15T14:32:09Z CHARGE_START pct=34"; parsed in DiagnosticCard.
export interface EventLogEntry {
  line: string;
  seq: number;
}

type SerialEvent =
  | { event: 'line'; data: RecordLine }
  | { event: 'disconnected' };

export type DataSource = 'live' | 'replay' | null;

/** What the journal shows: the running session, a past one, or a file. */
export type JournalView =
  | { kind: 'live' }
  | { kind: 'session'; id: number }
  | { kind: 'file'; name: string };

export function useBackend() {
  const [connected, setConnected] = useState(false);
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>(null);
  const [currentPort, setCurrentPort] = useState<string | null>(null);
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [liveSessionId, setLiveSessionId] = useState<number | null>(null);
  const [view, setView] = useState<JournalView | null>(null);
  /** Profile of what the journal shows, which is not the device's when viewing the past. */
  const [viewProfile, setViewProfile] = useState<Profile | null>(null);

  // The running session, kept whole whatever the journal shows.
  const liveLinesRef = useRef<RecordLine[]>([]);
  const viewLinesRef = useRef<RecordLine[]>([]);
  const viewRef = useRef<JournalView | null>(null);
  const showCallbackRef = useRef<((lines: RecordLine[]) => void) | null>(null);
  const lineCallbackRef = useRef<((line: RecordLine) => void) | null>(null);
  const onDisconnectedRef = useRef<(() => void) | null>(null);
  // Held in a ref so the Channel is not garbage-collected.
  const channelRef = useRef<Channel<SerialEvent> | null>(null);

  const show = useCallback((v: JournalView, lines: RecordLine[], p: Profile | null) => {
    viewRef.current = v;
    viewLinesRef.current = lines;
    setView(v);
    setViewProfile(p);
    showCallbackRef.current?.(lines);
  }, []);

  const refreshSessions = useCallback(async () => {
    const list = await invoke<SessionInfo[]>('get_sessions');
    setSessions(list);
    setLiveSessionId(list.find((s) => s.current)?.id ?? null);
    return list;
  }, []);

  const createChannel = useCallback((): Channel<SerialEvent> => {
    const channel = new Channel<SerialEvent>();
    channel.onmessage = (event) => {
      switch (event.event) {
        case 'line': {
          const line = event.data;
          const live = viewRef.current?.kind === 'live';
          if (line.type === 'session') {
            liveLinesRef.current = [line];
            setProfileState(line.profile);
            setLiveSessionId(line.id);
            refreshSessions().catch((e) => console.warn('[sessions]', e));
            if (live) show({ kind: 'live' }, liveLinesRef.current, line.profile);
          } else {
            liveLinesRef.current.push(line);
            if (live) lineCallbackRef.current?.(line);
          }
          break;
        }
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
  }, [refreshSessions, show]);

  const connect = useCallback(async (portName: string): Promise<void> => {
    setLoading(true);
    try {
      const channel = createChannel();
      const info = await invoke<ConnectInfo>('serial_connect', {
        portName,
        utc: Math.floor(Date.now() / 1000),
        offsetMin: -new Date().getTimezoneOffset(),
        onEvent: channel,
      });
      if (info.clock.didSync) {
        console.info(`[TIME] clock set (drift=${info.clock.driftS.toFixed(1)}s, wasInvalid=${info.clock.wasInvalid})`);
      }
      setConnected(true);
      setCurrentPort(portName);
      setDataSource('live');
      setFirmware(info.firmware);
      setProfileState(info.profile);

      const list = await refreshSessions();
      const running = list.find((s) => s.current);
      liveLinesRef.current = running
        ? await invoke<RecordLine[]>('get_session', { id: running.id })
        : [];
      show({ kind: 'live' }, liveLinesRef.current, info.profile);
    } finally {
      setLoading(false);
    }
  }, [createChannel, refreshSessions, show]);

  const disconnect = useCallback(async () => {
    try {
      await invoke('serial_disconnect');
    } catch (e) {
      // Fails harmlessly if already disconnected.
      console.warn('[useBackend] disconnect error:', e);
    }
    channelRef.current = null;
    setConnected(false);
    setProfileState(null);
    setCurrentPort(null);
    setDataSource(null);
    setFirmware(null);
    setSessions([]);
    setLiveSessionId(null);
  }, []);

  const showLive = useCallback(() => {
    show({ kind: 'live' }, liveLinesRef.current, profileOf(liveLinesRef.current) ?? profile);
  }, [show, profile]);

  const fetchSession = useCallback((id: number) => {
    return invoke<RecordLine[]>('get_session', { id });
  }, []);

  const openSession = useCallback(async (id: number) => {
    if (id === liveSessionId) {
      showLive();
      return;
    }
    const lines = await fetchSession(id);
    show({ kind: 'session', id }, lines, profileOf(lines));
  }, [liveSessionId, showLive, fetchSession, show]);

  const loadFile = useCallback((name: string, lines: RecordLine[]) => {
    setDataSource('replay');
    setCurrentPort(null);
    show({ kind: 'file', name }, lines, profileOf(lines));
  }, [show]);

  const closeView = useCallback(() => {
    viewRef.current = null;
    viewLinesRef.current = [];
    setView(null);
    setViewProfile(null);
    setDataSource(null);
    showCallbackRef.current?.([]);
  }, []);

  /** Only the fields given change; the device closes the session either way. */
  const setProfile = useCallback(async (patch: Profile): Promise<Profile> => {
    const p = await invoke<Profile>('set_profile', { profile: patch });
    setProfileState(p);
    return p;
  }, []);

  /** Closes the running session; the device opens the next one at once. */
  const newSession = useCallback(async () => {
    await invoke<Profile>('set_profile', { profile: {} });
  }, []);

  const transmit = useCallback(async (hex: string) => {
    await invoke('transmit', { hex });
  }, []);

  const getEvents = useCallback(async (): Promise<EventLogEntry[]> => {
    return invoke<EventLogEntry[]>('get_events');
  }, []);

  /** Lines currently shown, for export. */
  const getViewLines = useCallback(() => viewLinesRef.current, []);

  const onShow = useCallback((cb: (lines: RecordLine[]) => void) => {
    showCallbackRef.current = cb;
    return () => { showCallbackRef.current = null; };
  }, []);

  /** Live lines while the journal shows the running session. */
  const onLine = useCallback((cb: (line: RecordLine) => void) => {
    lineCallbackRef.current = cb;
    return () => { lineCallbackRef.current = null; };
  }, []);

  const setOnDisconnected = useCallback((cb: (() => void) | null) => {
    onDisconnectedRef.current = cb;
  }, []);

  return {
    connected, profile, viewProfile,
    dataSource, currentPort, firmware, loading,
    sessions, liveSessionId, view,
    connect, disconnect,
    setProfile, newSession, transmit,
    refreshSessions, openSession, fetchSession, showLive, loadFile, closeView,
    getViewLines, getEvents,
    onShow, onLine, setOnDisconnected,
  };
}
