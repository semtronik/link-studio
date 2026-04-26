import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { StatusIndicator } from './StatusIndicator';
import { HexColorized } from './HexColorized';
import type { DecodedFrame, Annotation } from '../types/parser';

interface FrameTableProps {
  frames: DecodedFrame[];
  annotations: Record<string, Annotation>;
  selectedFrameId: string | null;
  onSelectFrame: (frame: DecodedFrame | null) => void;
}

const ANNOTATION_STYLES: Record<Annotation['status'], string> = {
  ok: 'bg-rssi-good/15 text-rssi-good',
  error: 'bg-rssi-bad/15 text-rssi-bad',
  warning: 'bg-yellow-500/15 text-yellow-400',
  linked: 'bg-brand/15 text-brand',
};

function formatTimestamp(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/* ============================================================
 * Tri colonnes
 *
 * Cycle au clic sur un en-tête : asc → desc → reset (ordre natif d'arrivée).
 * L'auto-scroll vers le bas n'est actif que sans tri (sinon il combat
 * l'ordre choisi).
 * ============================================================ */
type SortKey = 'timestamp' | 'rssi' | 'snr' | 'size';
type SortDir = 'asc' | 'desc';
interface SortState {
  key: SortKey;
  dir: SortDir;
}

function getSortValue(frame: DecodedFrame, key: SortKey): number {
  switch (key) {
    case 'timestamp': return frame.timestamp;
    case 'rssi':     return frame.rssi ?? Number.NEGATIVE_INFINITY;
    case 'snr':      return frame.snr  ?? Number.NEGATIVE_INFINITY;
    case 'size':     return frame.hex.length / 2;
  }
}

interface SortableHeaderProps {
  label: string;
  sortKey: SortKey;
  sort: SortState | null;
  onSort: (key: SortKey) => void;
  className?: string;
}

function SortableHeader({ label, sortKey, sort, onSort, className }: SortableHeaderProps) {
  const isActive = sort?.key === sortKey;
  const arrow = !isActive ? '' : sort?.dir === 'asc' ? ' ▲' : ' ▼';
  const baseClasses = 'bg-surface-elevated px-4 py-2 text-left text-[12px] font-medium text-text-secondary uppercase tracking-wider border-b border-border cursor-pointer select-none hover:bg-overlay';
  return (
    <th
      className={`${baseClasses} ${className ?? ''}`}
      onClick={() => onSort(sortKey)}
      title="Cliquer pour trier"
    >
      {label}
      <span className="text-text-muted">{arrow}</span>
    </th>
  );
}

export function FrameTable({ frames, annotations, selectedFrameId, onSelectFrame }: FrameTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUp = useRef(false);
  const prevFrameCount = useRef(frames.length);

  const [sort, setSort] = useState<SortState | null>(null);

  /* Cycle de tri au clic : pas trié → asc → desc → pas trié. */
  const handleSort = useCallback((key: SortKey) => {
    setSort(prev => {
      if (prev?.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  }, []);

  /* Frames triées si un tri est actif, sinon ordre natif d'arrivée. */
  const displayedFrames = useMemo(() => {
    if (!sort) return frames;
    const copy = [...frames];
    copy.sort((a, b) => {
      const va = getSortValue(a, sort.key);
      const vb = getSortValue(b, sort.key);
      const diff = va - vb;
      return sort.dir === 'asc' ? diff : -diff;
    });
    return copy;
  }, [frames, sort]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 50;
    isUserScrolledUp.current = el.scrollTop + el.clientHeight < el.scrollHeight - threshold;
  }, []);

  /* Auto-scroll uniquement quand pas de tri actif (sinon on combat
   * l'ordre choisi par l'utilisateur). */
  useEffect(() => {
    if (sort) return;
    if (frames.length > prevFrameCount.current && !isUserScrolledUp.current) {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
    prevFrameCount.current = frames.length;
  }, [frames.length, sort]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-auto rounded-card bg-surface border border-[rgba(255,255,255,0.04)] shadow-subtle"
    >
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10">
          <tr>
            <SortableHeader label="Horodatage"     sortKey="timestamp" sort={sort} onSort={handleSort} className="w-[170px]" />
            <SortableHeader label="RSSI"           sortKey="rssi"      sort={sort} onSort={handleSort} className="w-[140px]" />
            <SortableHeader label="SNR"            sortKey="snr"       sort={sort} onSort={handleSort} className="w-[140px]" />
            <SortableHeader label="Taille (octets)" sortKey="size"     sort={sort} onSort={handleSort} className="w-20" />
            <th className="bg-surface-elevated px-4 py-2 text-left text-[12px] font-medium text-text-secondary uppercase tracking-wider border-b border-border">Payload</th>
            <th className="bg-surface-elevated px-4 py-2 text-left text-[12px] font-medium text-text-secondary uppercase tracking-wider border-b border-border w-48">Analyse</th>
          </tr>
        </thead>
        <tbody>
          {displayedFrames.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-text-muted italic">
                En attente de trames...
              </td>
            </tr>
          ) : (
            displayedFrames.map((frame) => (
              <tr
                key={frame.id}
                className={`border-b border-[rgba(255,255,255,0.04)] cursor-pointer hover:bg-brand-50 transition-colors duration-200 ${
                  selectedFrameId === frame.id ? 'bg-brand-100' : ''
                }`}
                onClick={() => onSelectFrame(selectedFrameId === frame.id ? null : frame)}
              >
                <td className="px-4 py-2 font-mono text-xs text-text-muted whitespace-nowrap">
                  {formatTimestamp(frame.timestamp)}
                </td>
                <td className="px-4 py-2">
                  {frame.rssi != null ? (
                    <StatusIndicator value={frame.rssi} type="rssi" />
                  ) : (
                    <span className="text-text-muted">-</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {frame.snr != null ? (
                    <StatusIndicator value={frame.snr} type="snr" />
                  ) : (
                    <span className="text-text-muted">-</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-text-secondary whitespace-nowrap">
                  {frame.hex.length / 2}
                </td>
                <td className="px-4 py-2">
                  <HexColorized hex={frame.hex} fields={frame.decoded?.fields} />
                </td>
                <td className="px-4 py-2">
                  {annotations[frame.id] && (
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${ANNOTATION_STYLES[annotations[frame.id].status]}`}>
                      {annotations[frame.id].label}
                    </span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
