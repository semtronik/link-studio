import type { ParserInfo } from '../types/parser';

interface ParserSelectorProps {
  parserInfo: ParserInfo | null;
  parserError: string | null;
  onImport: () => void;
  onReset: () => void;
}

export function ParserSelector({ parserInfo, parserError, onImport, onReset }: ParserSelectorProps) {
  return (
    <div className="flex items-center gap-2 text-sm whitespace-nowrap">
      <span className="text-text-muted">Parser:</span>
      <span className="font-medium text-text-primary">
        {parserInfo?.name || 'None'}
      </span>
      {parserInfo?.version && (
        <span className="text-text-muted text-xs">v{parserInfo.version}</span>
      )}

      <button
        onClick={onImport}
        className="px-2 py-0.5 bg-brand/12 text-brand rounded-element text-xs font-medium whitespace-nowrap flex-shrink-0 hover:bg-brand/20 transition-colors duration-200"
      >
        Import .js
      </button>

      {parserInfo && parserInfo.name !== 'Raw' && (
        <button
          onClick={onReset}
          className="px-2 py-0.5 bg-overlay text-text-secondary rounded-element text-xs font-medium hover:bg-surface-elevated transition-colors duration-200"
        >
          Raw
        </button>
      )}

      {parserError && (
        <span className="text-rssi-bad text-xs">{parserError}</span>
      )}
    </div>
  );
}
