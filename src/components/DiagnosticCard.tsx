import { useState, useCallback, useEffect } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useSerialContext } from '../contexts/SerialContext';
import type { EventLogEntry } from '../hooks/useBackend';

interface ParsedEvent {
  seq: number;
  timestampDisplay: string;
  timestampRaw: string;
  event: string;
  details: string;
  raw: string;
}

function parseEvent(entry: EventLogEntry): ParsedEvent {
  const line = entry.line;
  const parts = line.split(/\s+/);
  if (parts.length < 2) {
    return {
      seq: entry.seq,
      timestampDisplay: '?',
      timestampRaw: '',
      event: line,
      details: '',
      raw: line,
    };
  }

  const ts = parts[0];
  const ev = parts[1] || '';
  const details = parts.slice(2).join(' ');

  let display = ts;
  if (ts.startsWith('uptime=')) {
    const m = ts.match(/uptime=(\d+)s/);
    if (m) {
      const s = parseInt(m[1], 10);
      if (s < 60) display = `Boot + ${s}s`;
      else if (s < 3600) display = `Boot + ${Math.floor(s / 60)}m ${s % 60}s`;
      else display = `Boot + ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    }
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) {
      display = d.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }
  }

  return {
    seq: entry.seq,
    timestampDisplay: display,
    timestampRaw: ts,
    event: ev,
    details,
    raw: line,
  };
}

function eventBadgeClass(ev: string): string {
  if (ev === 'BOOT' || ev === 'SHUTDOWN' || ev === 'TIME_SYNC') {
    return 'bg-brand/15 text-brand border-brand/30';
  }
  if (ev === 'WIO_CONNECTED' || ev === 'CHARGE_END') {
    return 'bg-green-500/15 text-green-400 border-green-500/30';
  }
  if (ev.endsWith('_ERROR') || ev.endsWith('_FAIL')) {
    return 'bg-red-500/15 text-red-400 border-red-500/30';
  }
  if (ev.startsWith('BAT_')) {
    return 'bg-orange-500/15 text-orange-400 border-orange-500/30';
  }
  if (ev.startsWith('CHARGE_')) {
    return 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30';
  }
  return 'bg-surface text-text-secondary border-border';
}

function toCsv(rows: ParsedEvent[]): string {
  const header = 'seq,timestamp,event,details,raw';
  const escape = (s: string) => {
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = rows.map(r =>
    [r.seq, escape(r.timestampRaw), escape(r.event), escape(r.details), escape(r.raw)].join(',')
  );
  return [header, ...lines].join('\n');
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6 animate-spin text-brand">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

async function exportCsv(rows: ParsedEvent[]) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = await save({
    defaultPath: `link-events-${stamp}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!path) return;
  await writeTextFile(path, toCsv(rows));
}

export function DiagnosticCard() {
  const { connected, getEvents } = useSerialContext();

  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<ParsedEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = await getEvents();
      const parsed = raw.map(parseEvent).sort((a, b) => b.seq - a.seq);
      setEntries(parsed);
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error).message ?? 'Unknown error';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [getEvents]);

  useEffect(() => {
    if (connected) {
      handleFetch();
    }
  }, [connected, handleFetch]);

  return (
    <div className="bg-surface rounded-modal border border-border flex flex-col w-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50">
        <h2 className="text-sm font-semibold text-text flex-1">Diagnostic</h2>
        <button
          onClick={handleFetch}
          disabled={!connected || loading}
          className="px-3 py-1.5 text-[12px] rounded-element bg-brand/15 text-brand border border-brand/30 hover:bg-brand/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button
          onClick={() => entries && exportCsv(entries).catch(e => setError(e instanceof Error ? e.message : String(e)))}
          disabled={!entries || entries.length === 0}
          className="px-3 py-1.5 text-[12px] rounded-element bg-surface text-text-secondary border border-border hover:text-text hover:border-brand/50 hover:bg-overlay active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:bg-surface transition-all"
        >
          Export CSV
        </button>
      </div>

      <div className="min-h-[400px] max-h-[400px] overflow-y-auto relative">
        {!connected ? (
          <div className="px-4 py-12 text-center text-text-muted text-sm">
            Connect a device to see its events
          </div>
        ) : loading && entries === null ? (
          <div className="px-4 py-12 flex flex-col items-center justify-center gap-3">
            <Spinner />
            <span className="text-text-muted text-xs">Fetching events…</span>
          </div>
        ) : error ? (
          <div className="px-4 py-12 text-center text-rssi-bad text-sm">
            {error}
          </div>
        ) : entries === null || entries.length === 0 ? (
          <div className="px-4 py-12 text-center text-text-muted text-sm">
            No events recorded
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border/30 font-mono text-[12px]">
              {entries.map(e => (
                <li key={e.seq} className="px-4 py-1.5 flex items-baseline gap-3 hover:bg-surface/40">
                  <span className="text-text-muted w-10 shrink-0">{e.seq}</span>
                  <span className="text-text-secondary w-44 shrink-0" title={e.timestampRaw}>
                    {e.timestampDisplay}
                  </span>
                  <span className={`inline-block px-2 py-0.5 rounded border text-[11px] shrink-0 ${eventBadgeClass(e.event)}`}>
                    {e.event}
                  </span>
                  <span className="text-text flex-1 truncate" title={e.details}>
                    {e.details || <span className="text-text-muted">—</span>}
                  </span>
                </li>
              ))}
            </ul>
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-surface/60 backdrop-blur-[1px]">
                <Spinner />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
