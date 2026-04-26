import type { LoRaConfig as LoRaConfigType } from '../types/lora';

interface LoRaConfigProps {
  config: LoRaConfigType | null;
  canModify: boolean;
  onOpenConfig: () => void;
}

const PARAMS = [
  { key: 'freq', label: 'Fréquence', display: (v: number) => `${v.toFixed(3)} MHz` },
  { key: 'sf', label: 'Spreading Factor', display: (v: number) => `SF${v}` },
  { key: 'bw', label: 'Bandwidth', display: (v: number) => `${v} kHz` },
];

export function LoRaConfig({ config, canModify, onOpenConfig }: LoRaConfigProps) {
  if (!config) {
    return (
      <div className="bg-surface rounded-card p-4 text-center text-text-muted border border-border text-[13px]">
        Config non disponible
      </div>
    );
  }

  const values: Record<string, number> = {
    freq: config.freq,
    sf: config.sf,
    bw: config.bw,
  };

  return (
    <div className="bg-surface rounded-card shadow-subtle p-4 border border-border">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[13px] font-medium text-text-secondary uppercase tracking-wider">
          Configuration Radio
        </h2>
        {canModify && (
          <button
            onClick={onOpenConfig}
            className="text-[13px] text-brand hover:text-brand-hover transition-colors"
          >
            Modifier
          </button>
        )}
      </div>

      <div className="divide-y divide-border/50">
        {PARAMS.map(param => (
          <div key={param.key} className="flex justify-between items-center py-2">
            <span className="text-[13px] text-text-secondary">{param.label}</span>
            <span className="font-mono text-[13px] text-text-primary">{param.display(values[param.key])}</span>
          </div>
        ))}
      </div>

      {config.drops > 0 && (
        <div className="mt-3 text-xs text-text-muted flex justify-between items-center pt-2 border-t border-border/50">
          <span>Packets droppés</span>
          <span className="font-mono text-rssi-medium">{config.drops}</span>
        </div>
      )}
    </div>
  );
}
