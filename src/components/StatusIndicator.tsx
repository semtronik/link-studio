type SignalLevel = 'good' | 'medium' | 'bad';

interface StatusIndicatorProps {
  value: number;
  type: 'rssi' | 'snr';
}

const THRESHOLDS = {
  rssi: { good: -80, medium: -100, min: -130, max: -30, unit: 'dBm', decimals: 0 },
  snr: { good: 5, medium: 0, min: -10, max: 15, unit: 'dB', decimals: 1 },
} as const;

const LEVEL_CLASSES: Record<SignalLevel, { bar: string; text: string }> = {
  good: { bar: 'bg-rssi-good', text: 'text-rssi-good' },
  medium: { bar: 'bg-rssi-medium', text: 'text-rssi-medium' },
  bad: { bar: 'bg-rssi-bad', text: 'text-rssi-bad' },
};

function getLevel(value: number, good: number, medium: number): SignalLevel {
  if (value > good) return 'good';
  if (value > medium) return 'medium';
  return 'bad';
}

function getPercent(value: number, min: number, max: number): number {
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

const LEVEL_LABELS: Record<SignalLevel, string> = {
  good: 'good',
  medium: 'fair',
  bad: 'weak',
};

export function StatusIndicator({ value, type }: StatusIndicatorProps) {
  const t = THRESHOLDS[type];
  const level = getLevel(value, t.good, t.medium);
  const percent = getPercent(value, t.min, t.max);
  const classes = LEVEL_CLASSES[level];
  const formatted = t.decimals > 0 ? value.toFixed(t.decimals) : String(value);

  return (
    <div
      className="flex items-center gap-2"
      aria-label={`${type.toUpperCase()}: ${formatted} ${t.unit}, signal ${LEVEL_LABELS[level]}`}
    >
      <div className="w-[60px] h-1.5 bg-overlay rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${classes.bar}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className={`font-mono text-xs ${classes.text} min-w-[52px] text-right`}>
        {formatted} {t.unit}
      </span>
    </div>
  );
}
