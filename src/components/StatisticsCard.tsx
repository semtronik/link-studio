import { useEffect, useMemo, useState } from 'react';
import { useFrameContext } from '../contexts/FrameContext';
import { MARGIN_TEXT } from './MarginValue';
import { marginClass, MARGIN_FAIR_DB, MARGIN_GOOD_DB, type MarginClass } from '../utils/journal';

const MARGIN_ROWS: Array<[MarginClass, string]> = [
  ['good', `≥ ${MARGIN_GOOD_DB} dB`],
  ['fair', `${MARGIN_FAIR_DB} to ${MARGIN_GOOD_DB} dB`],
  ['poor', `< ${MARGIN_FAIR_DB} dB`],
];

function formatLastFrameAge(ageSeconds: number): { text: string; level: 'normal' | 'warning' | 'alert' } {
  let level: 'normal' | 'warning' | 'alert' = 'normal';
  if (ageSeconds >= 1800) level = 'alert';
  else if (ageSeconds >= 300) level = 'warning';

  let text: string;
  if (ageSeconds < 60) {
    text = `${Math.floor(ageSeconds)}s ago`;
  } else if (ageSeconds < 3600) {
    text = `${Math.floor(ageSeconds / 60)} min ago`;
  } else {
    const h = Math.floor(ageSeconds / 3600);
    const m = Math.floor((ageSeconds % 3600) / 60);
    text = `${h}h ${m}min ago`;
  }
  return { text, level };
}

export function StatisticsCard() {
  const { frames } = useFrameContext();

  /* Computed from frames, not the backend: backend stats don't refresh after loading a capture. */
  const avgRssi = useMemo(() => {
    const vals = frames.map(f => f.rssi).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }, [frames]);

  const avgSnr = useMemo(() => {
    const vals = frames.map(f => f.snr).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }, [frames]);

  /* As the device counts them (link_stats.c): margin classes for intact frames only;
   * errors count as receptions, the radio started one. */
  const counts = useMemo(() => {
    let ok = 0, errors = 0, sent = 0;
    const margin: Record<MarginClass, number> = { good: 0, fair: 0, poor: 0 };
    for (const f of frames) {
      if (f.kind === 'tx') sent++;
      else if (f.kind === 'rx') {
        if (f.status === 'ok') {
          ok++;
          if (f.margin != null) margin[marginClass(f.margin)]++;
        } else errors++;
      }
    }
    return { ok, errors, sent, margin };
  }, [frames]);

  /* Re-render every 10 s to refresh the "last frame" age. */
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTickNow(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);

  if (frames.length === 0) {
    return (
      <div className="bg-surface rounded-card p-4 text-center text-text-muted border border-border text-[13px]">
        Connect a device or open a recording to see statistics
      </div>
    );
  }

  const lastFrame = [...frames].reverse().find(f => f.kind === 'rx') ?? null;
  const lastFrameAge = lastFrame ? (tickNow / 1000) - lastFrame.timestamp : null;
  const lastFrameDisplay = lastFrameAge != null ? formatLastFrameAge(lastFrameAge) : null;
  const ageColorClass =
    lastFrameDisplay?.level === 'alert' ? 'text-red-500'
    : lastFrameDisplay?.level === 'warning' ? 'text-amber-500'
    : 'text-text-secondary';

  return (
    <div className="bg-surface/80 backdrop-blur-sm rounded-card shadow-subtle p-4 border border-border/50">
      <h2 className="text-[13px] font-medium text-text-secondary uppercase tracking-wider mb-2">
        Statistics
      </h2>

      <div className="divide-y divide-border/50">
        <div className="flex justify-between items-center py-2">
          <span className="text-[13px] text-text-secondary">Received</span>
          <span className="font-mono text-[13px] text-text-primary">
            {counts.ok}
            {counts.errors > 0 && <span className="text-rssi-bad"> + {counts.errors} errors</span>}
          </span>
        </div>

        {counts.ok > 0 && (
          <div className="py-2">
            <div className="text-[13px] text-text-secondary mb-1.5">Margin</div>
            {MARGIN_ROWS.map(([cls, label]) => (
              <div key={cls} className="flex justify-between items-center py-0.5">
                <span className={`inline-flex items-center gap-1.5 text-[12px] ${MARGIN_TEXT[cls]}`}>
                  <span className="w-2 h-2 rounded-full bg-current" />
                  {label}
                </span>
                <span className="font-mono text-[13px] text-text-primary">
                  {counts.margin[cls]}
                  <span className="text-text-muted"> · {Math.round((counts.margin[cls] / counts.ok) * 100)} %</span>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-between items-center py-2">
          <span className="text-[13px] text-text-secondary">Sent</span>
          <span className="font-mono text-[13px] text-text-primary">{counts.sent}</span>
        </div>

        <div className="flex justify-between items-center py-2">
          <span className="text-[13px] text-text-secondary">Avg RSSI</span>
          <span className="font-mono text-[13px] text-text-primary">
            {avgRssi != null ? `${avgRssi.toFixed(0)} dBm` : '--'}
          </span>
        </div>

        <div className="flex justify-between items-center py-2">
          <span className="text-[13px] text-text-secondary">Avg SNR</span>
          <span className="font-mono text-[13px] text-text-primary">
            {avgSnr != null ? `${avgSnr.toFixed(1)} dB` : '--'}
          </span>
        </div>

        {lastFrameDisplay && (
          <div className="flex justify-between items-center py-2">
            <span className="text-[13px] text-text-secondary">Last reception</span>
            <span className={`text-[13px] ${ageColorClass}`}>
              {lastFrameDisplay.text}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
