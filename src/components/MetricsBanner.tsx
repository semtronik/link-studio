import type { Metric } from '../types/parser';

interface MetricsBannerProps {
  metrics: Metric[];
}

export function MetricsBanner({ metrics }: MetricsBannerProps) {
  if (metrics.length === 0) return null;

  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-surface rounded-card border border-[rgba(255,255,255,0.04)] shadow-subtle flex-shrink-0 overflow-x-auto">
      <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider whitespace-nowrap">Analysis</span>
      <div className="h-4 w-px bg-border" />
      {metrics.map((m, i) => (
        <div key={i} className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="text-[11px] text-text-muted">{m.name}</span>
          <span className="text-[12px] font-mono font-medium text-text-primary">{m.value}</span>
        </div>
      ))}
    </div>
  );
}
