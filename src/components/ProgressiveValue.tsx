type SignalLevel = 'good' | 'medium' | 'bad';

interface ProgressiveValueProps {
  value: number;
  type: 'rssi' | 'snr' | 'per';
  decimals?: number;
  unit?: string;
}

const THRESHOLDS: Record<string, { good: number; medium: number }> = {
  rssi: { good: -80, medium: -100 },
  snr: { good: 5, medium: 0 },
  per: { good: 1, medium: 5 },
};

const LEVEL_TEXT_CLASSES: Record<SignalLevel, string> = {
  good: 'text-rssi-good',
  medium: 'text-rssi-medium',
  bad: 'text-rssi-bad',
};

function getLevel(value: number, type: string): SignalLevel {
  const t = THRESHOLDS[type];
  if (type === 'per') {
    // PER: lower is better (inverted)
    if (value < t.good) return 'good';
    if (value < t.medium) return 'medium';
    return 'bad';
  }
  if (value > t.good) return 'good';
  if (value > t.medium) return 'medium';
  return 'bad';
}

export function ProgressiveValue({ value, type, decimals = 1, unit }: ProgressiveValueProps) {
  const level = getLevel(value, type);
  const formatted = value.toFixed(decimals);
  const display = unit ? `${formatted} ${unit}` : formatted;

  return (
    <span
      className={`font-mono text-[13px] ${LEVEL_TEXT_CLASSES[level]}`}
      title={`${value} ${unit || ''}`}
    >
      {display}
    </span>
  );
}
