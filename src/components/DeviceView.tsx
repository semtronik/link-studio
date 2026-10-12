import { FirmwareFlasher } from './FirmwareFlasher';
import { DiagnosticCard } from './DiagnosticCard';

interface DeviceViewProps {
  onClose: () => void;
}

export function DeviceView({ onClose }: DeviceViewProps) {
  return (
    <div className="flex flex-col h-full w-full bg-base">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
        <button
          onClick={onClose}
          title="Back"
          className="w-8 h-8 flex items-center justify-center rounded-element text-text-secondary hover:text-text hover:bg-surface transition-colors"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z" clipRule="evenodd" />
          </svg>
        </button>
        <h1 className="text-sm font-semibold text-text">Device</h1>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="flex flex-col lg:flex-row gap-4 max-w-6xl mx-auto">
          <div className="bg-surface rounded-modal border border-border p-4 w-full lg:w-1/3 lg:shrink-0">
            <FirmwareFlasher />
          </div>
          <div className="w-full lg:flex-1 lg:min-w-0">
            <DiagnosticCard />
          </div>
        </div>
      </div>
    </div>
  );
}
