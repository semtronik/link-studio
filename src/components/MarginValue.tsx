import { marginClass, type MarginClass } from '../utils/journal';

export const MARGIN_TEXT: Record<MarginClass, string> = {
  good: 'text-rssi-good',
  fair: 'text-rssi-medium',
  poor: 'text-rssi-bad',
};

/** Link margin, coloured like the device's journal. */
export function MarginValue({ value }: { value: number }) {
  const cls = marginClass(value);
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[13px] ${MARGIN_TEXT[cls]}`}>
      <span className="w-2 h-2 rounded-full bg-current" />
      {value.toFixed(1)} dB
    </span>
  );
}
