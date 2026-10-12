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

/* Same format as the device screen (format_delta in ui_screen_monitor.c). */
function formatDelta(deltaMs: number | null): string {
  if (deltaMs == null || deltaMs < 0) return '';
  if (deltaMs < 1000) return `+${Math.round(deltaMs)}ms`;
  if (deltaMs < 10000) {
    const s = Math.floor(deltaMs / 1000);
    const tenths = Math.floor((deltaMs % 1000) / 100);
    return `+${s}.${tenths}s`;
  }
  if (deltaMs < 60000) return `+${Math.floor(deltaMs / 1000)}s`;
  return `+${Math.floor(deltaMs / 60000)}min`;
}

/* Always newest first, no column sort: deltas only make sense in time order.
 * Isolating frames by quality calls for a filter, not a sort. */

const HEADER_CLASSES =
  'bg-surface-elevated px-4 py-2 text-left text-[12px] font-medium text-text-secondary uppercase tracking-wider border-b border-border';

/* Shared by the header and each row: this grid is what aligns the columns. */
const GRID_CLASSES =
  'grid grid-cols-[minmax(260px,1fr)_80px_140px_140px] items-center gap-4';

const PAYLOAD_PREVIEW_BYTES = 8;

/* Deliberately overestimated: parser field groups add padding, and underestimating overflows the row. */
const BYTE_RENDER_WIDTH = 26;

const MAX_ROWS = 1000;

const BADGE = 'flex-shrink-0 inline-block px-2 py-0.5 rounded-full text-[11px] font-medium';

/* What sets a row apart from a frame received intact. */
function kindBadge(frame: DecodedFrame): { label: string; className: string } | null {
  if (frame.kind === 'tx') {
    const label = frame.status === 'ok' || !frame.status ? 'TX' : `TX ${frame.status}`;
    const className = frame.status === 'ok' ? 'bg-brand/15 text-brand' : 'bg-rssi-bad/15 text-rssi-bad';
    return { label, className };
  }
  if (frame.kind === 'rx') {
    switch (frame.status) {
      case 'crc_err': return { label: 'CRC error', className: 'bg-rssi-bad/15 text-rssi-bad' };
      case 'header_err': return { label: 'Header error', className: 'bg-rssi-bad/15 text-rssi-bad' };
      case 'incomplete': return { label: 'Incomplete', className: 'bg-yellow-500/15 text-yellow-400' };
    }
  }
  return null;
}

/* gap and lost: a break in reception, not a frame. */
function breakText(frame: DecodedFrame): string | null {
  if (frame.line.type === 'gap') {
    const { from, to, reason } = frame.line;
    const s = from != null && to != null ? ` for ${((to - from) / 1000).toFixed(1)} s` : '';
    return `Reception interrupted${s} (${reason === 'radio_reset' ? 'radio reset' : reason})`;
  }
  if (frame.line.type === 'lost') {
    return `${frame.line.count} line${frame.line.count !== 1 ? 's' : ''} lost by the device`;
  }
  return null;
}

export function FrameTable({ frames, annotations, selectedFrameId, onSelectFrame }: FrameTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isUserScrolledDown = useRef(false);
  const payloadColRef = useRef<HTMLDivElement>(null);
  const selectedRowRef = useRef<HTMLDivElement>(null);
  const prevFrameCount = useRef(frames.length);

  /* Deltas are computed in arrival order, BEFORE reversing for display.
   * Rows are not virtualized: only the latest MAX_ROWS are rendered. */
  const displayedFrames = useMemo(() => {
    const first = Math.max(0, frames.length - MAX_ROWS);
    return frames
      .slice(first)
      .map((frame, i) => {
        const prev = frames[first + i - 1];
        return {
          frame,
          deltaMs: prev ? (frame.timestamp - prev.timestamp) * 1000 : null,
        };
      })
      .reverse();
  }, [frames]);

  /* Measured once for the whole table; the 24px reserve leaves room for "...". */
  const [payloadWidth, setPayloadWidth] = useState(0);

  useEffect(() => {
    const el = payloadColRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      setPayloadWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visibleBytes = useMemo(() => {
    if (payloadWidth <= 0) return PAYLOAD_PREVIEW_BYTES;
    const fit = Math.floor((payloadWidth - 24) / BYTE_RENDER_WIDTH);
    return Math.max(1, Math.min(PAYLOAD_PREVIEW_BYTES, fit));
  }, [payloadWidth]);

  /* New frames land at the top; auto-follow stops once the user scrolls down. */
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 50;
    isUserScrolledDown.current = el.scrollTop > threshold;
  }, []);

  useEffect(() => {
    if (frames.length > prevFrameCount.current && !isUserScrolledDown.current) {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = 0;
      }
    }
    prevFrameCount.current = frames.length;
  }, [frames.length]);

  /* External selection: scroll only if the row is out of view. */
  useEffect(() => {
    if (!selectedFrameId) return;
    const row = selectedRowRef.current;
    const container = scrollRef.current;
    if (!row || !container) return;

    const rowRect = row.getBoundingClientRect();
    const boxRect = container.getBoundingClientRect();
    const visible = rowRect.top >= boxRect.top && rowRect.bottom <= boxRect.bottom;
    if (!visible) {
      row.scrollIntoView({ block: 'center' });
    }
  }, [selectedFrameId]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 min-h-[120px] overflow-auto rounded-card bg-surface border border-[rgba(255,255,255,0.04)] shadow-subtle"
    >
      {/* No <table>: its own width calculation drifted from the grid and misaligned the header. */}
      {/* No `min-w-max`: the column would grow with the payload and truncation would never trigger. */}
      <div className="text-sm">
        {/* Invisible probe measuring the first column without depending on a data row. */}
        <div className={`${GRID_CLASSES} h-0 invisible pointer-events-none px-4`} aria-hidden>
          <div ref={payloadColRef} />
        </div>
        <div className={`${HEADER_CLASSES} ${GRID_CLASSES} sticky top-0 z-10`}>
          <span>Frame</span>
          <span>Bytes</span>
          <span>RSSI</span>
          <span>SNR</span>
        </div>

        {displayedFrames.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-text-muted">No frames</p>
            <p className="text-[12px] text-text-muted mt-1">
              Connect a device or open a recording
            </p>
          </div>
        ) : (
          displayedFrames.map(({ frame, deltaMs }) => {
            const annotation = annotations[frame.id];
            const byteCount = frame.hex.length / 2;
            const badge = kindBadge(frame);
            const breakLabel = breakText(frame);

            const isSelected = selectedFrameId === frame.id;
            if (breakLabel) {
              return (
                <div
                  key={frame.id}
                  className="px-4 py-2 border-b border-[rgba(255,255,255,0.04)] bg-yellow-500/5 text-[12px] text-yellow-400"
                >
                  <span className="font-mono text-xs text-text-muted mr-3">{formatTimestamp(frame.timestamp)}</span>
                  {breakLabel}
                </div>
              );
            }
            return (
              <div
                key={frame.id}
                ref={isSelected ? selectedRowRef : undefined}
                className={`px-4 py-2.5 border-b border-[rgba(255,255,255,0.04)] cursor-pointer hover:bg-brand-50 transition-colors duration-200 ${
                  isSelected ? 'bg-brand-100' : ''
                }`}
                onClick={() => onSelectFrame(isSelected ? null : frame)}
              >
                <div className={GRID_CLASSES}>
                  <span className="font-mono text-xs text-text-muted whitespace-nowrap">
                    {formatTimestamp(frame.timestamp)}
                    {deltaMs != null && (
                      <span className="ml-2 text-text-secondary">{formatDelta(deltaMs)}</span>
                    )}
                  </span>
                  <span className="text-xs text-text-secondary whitespace-nowrap">
                    {byteCount || '-'}
                  </span>
                  <span>
                    {frame.rssi != null ? (
                      <StatusIndicator value={frame.rssi} type="rssi" />
                    ) : (
                      <span className="text-text-muted">-</span>
                    )}
                  </span>
                  <span>
                    {frame.snr != null ? (
                      <StatusIndicator value={frame.snr} type="snr" />
                    ) : (
                      <span className="text-text-muted">-</span>
                    )}
                  </span>
                </div>

                <div className={`${GRID_CLASSES} mt-1.5`}>
                  {/* `min-w-0`, or the payload widens the column instead of being truncated. */}
                  <div className="flex items-center gap-3 min-w-0">
                    {badge && <span className={`${BADGE} ${badge.className}`}>{badge.label}</span>}
                    <div className={`flex-1 min-w-0 flex items-center overflow-hidden ${frame.status === 'crc_err' ? 'opacity-50' : ''}`}>
                      <div className="min-w-0 overflow-hidden">
                        <HexColorized
                          hex={frame.hex}
                          fields={frame.decoded?.fields}
                          singleLine
                          maxBytes={visibleBytes}
                        />
                      </div>
                      {byteCount > visibleBytes && (
                        <span
                          className="flex-shrink-0 pl-1 font-mono text-[13px] text-text-muted"
                          title={`${byteCount} bytes total`}
                        >
                          ...
                        </span>
                      )}
                    </div>
                    {annotation && (
                      <span
                        className={`${BADGE} ${ANNOTATION_STYLES[annotation.status]}`}
                      >
                        {annotation.label}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        {frames.length > MAX_ROWS && (
          <div className="px-4 py-3 text-center text-[12px] text-text-muted">
            Latest {MAX_ROWS} of {frames.length} rows. Export to see the whole session.
          </div>
        )}
      </div>
    </div>
  );
}
