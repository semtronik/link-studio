import { useEffect, useMemo, useState } from 'react';
import { useFrameContext } from '../contexts/FrameContext';
import { ProgressiveValue } from './ProgressiveValue';

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

  /* Re-render every 10 s to refresh the "last frame" age. */
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTickNow(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);

  if (frames.length === 0) {
    return (
      <div className="bg-surface rounded-card p-4 text-center text-text-muted border border-border text-[13px]">
        Connect a device or load a capture to see statistics
      </div>
    );
  }

  const lastFrame = frames.length > 0 ? frames[frames.length - 1] : null;
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
          <span className="text-[13px] text-text-secondary">Avg RSSI</span>
          {avgRssi != null ? (
            <ProgressiveValue value={avgRssi} type="rssi" decimals={0} unit="dBm" />
          ) : (
            <span className="font-mono text-[13px] text-text-muted">--</span>
          )}
        </div>

        <div className="flex justify-between items-center py-2">
          <span className="text-[13px] text-text-secondary">Avg SNR</span>
          {avgSnr != null ? (
            <ProgressiveValue value={avgSnr} type="snr" decimals={1} unit="dB" />
          ) : (
            <span className="font-mono text-[13px] text-text-muted">--</span>
          )}
        </div>

        {lastFrameDisplay && (
          <div className="flex justify-between items-center py-2">
            <span className="text-[13px] text-text-secondary">Last frame</span>
            <span className={`text-[13px] ${ageColorClass}`}>
              {lastFrameDisplay.text}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
