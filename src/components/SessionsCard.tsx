import { useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useSerialContext } from '../contexts/SerialContext';
import { useToast } from '../contexts/ToastContext';
import type { SessionInfo } from '../types/recording';
import { formatBytes, toJsonl } from '../utils/journal';

const REASONS: Record<string, string> = {
  config: 'settings changed',
  profile: 'profile changed',
  scan: 'band sweep',
  clear: 'cleared',
  app: 'set from Link Studio',
  time: 'clock set',
  erase: 'recordings erased',
  shutdown: 'powered off',
  battery: 'battery empty',
  reboot_cmd: 'restarted',
};

function formatStart(ms?: number): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(s: SessionInfo): string | null {
  if (s.ts == null || s.end_ts == null) return null;
  const sec = Math.max(0, Math.round((s.end_ts - s.ts) / 1000));
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
}

export function SessionsCard() {
  const { connected, sessions, view, openSession, fetchSession, refreshSessions } = useSerialContext();
  const { addToast } = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);

  if (!connected) return null;

  const viewedId = view?.kind === 'session' ? view.id : null;

  const open = async (s: SessionInfo) => {
    setBusyId(s.id);
    try {
      await openSession(s.id);
    } catch (err) {
      addToast('error', `Session ${s.id}`, String(err));
    } finally {
      setBusyId(null);
    }
  };

  const download = async (s: SessionInfo) => {
    const path = await save({
      defaultPath: `link-lr_session-${s.id}.jsonl`,
      filters: [{ name: 'Link-LR recording', extensions: ['jsonl'] }],
    });
    if (!path) return;
    setBusyId(s.id);
    try {
      await writeTextFile(path, toJsonl(await fetchSession(s.id)));
      addToast('success', `Session ${s.id} saved`, path);
    } catch (err) {
      addToast('error', `Session ${s.id}`, String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-surface rounded-card shadow-subtle p-4 border border-border">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[13px] font-medium text-text-secondary uppercase tracking-wider">
          Sessions on device
        </h2>
        <button
          onClick={() => refreshSessions().catch((e) => addToast('error', 'Sessions', String(e)))}
          className="text-[13px] text-brand hover:text-brand-hover transition-colors"
        >
          Refresh
        </button>
      </div>

      {sessions.length === 0 ? (
        <p className="text-[12px] text-text-muted py-2">No recording yet</p>
      ) : (
        <div className="divide-y divide-border/50 max-h-[320px] overflow-y-auto -mx-1">
          {[...sessions].reverse().map((s) => {
            const live = s.current && view?.kind === 'live';
            const selected = live || viewedId === s.id;
            const duration = formatDuration(s);
            return (
              <div
                key={s.id}
                className={`flex items-center gap-2 px-1 py-1.5 rounded-element cursor-pointer transition-colors ${selected ? 'bg-brand-100' : 'hover:bg-brand-50'}`}
                onClick={() => open(s)}
                title={s.reason ? `Closed: ${REASONS[s.reason] ?? s.reason}` : undefined}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="font-mono text-text-primary">#{s.id}</span>
                    <span className="text-text-secondary">{formatStart(s.ts)}</span>
                    {s.current && <span className="text-[11px] font-medium text-rssi-good">LIVE</span>}
                  </div>
                  <div className="text-[11px] text-text-muted">
                    {[duration, formatBytes(s.bytes), s.truncated ? 'start rotated out' : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); download(s); }}
                  disabled={busyId === s.id}
                  title="Save as .jsonl"
                  className="w-7 h-7 flex items-center justify-center rounded-element text-text-muted hover:text-brand hover:bg-brand/10 transition-colors disabled:opacity-40"
                >
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path d="M10 3a1 1 0 011 1v7.586l2.293-2.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 11.586V4a1 1 0 011-1zM4 15a1 1 0 011 1v1h10v-1a1 1 0 112 0v2a1 1 0 01-1 1H4a1 1 0 01-1-1v-2a1 1 0 011-1z" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
