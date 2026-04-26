interface DeviceMenuButtonProps {
  onClick: () => void;
  active: boolean;
}

export function DeviceMenuButton({ onClick, active }: DeviceMenuButtonProps) {
  return (
    <button
      onClick={onClick}
      title="LFT"
      className={`w-9 h-9 flex items-center justify-center rounded-element transition-colors ${
        active
          ? 'bg-brand/20 text-brand'
          : 'text-brand/70 hover:text-brand hover:bg-brand/10'
      }`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5">
        <rect x="6" y="6" width="12" height="12" rx="1.5" />
        <rect x="9" y="9" width="6" height="6" rx="0.5" fill="currentColor" fillOpacity="0.2" />
        <line x1="9" y1="3" x2="9" y2="6" />
        <line x1="12" y1="3" x2="12" y2="6" />
        <line x1="15" y1="3" x2="15" y2="6" />
        <line x1="9" y1="18" x2="9" y2="21" />
        <line x1="12" y1="18" x2="12" y2="21" />
        <line x1="15" y1="18" x2="15" y2="21" />
        <line x1="3" y1="9" x2="6" y2="9" />
        <line x1="3" y1="12" x2="6" y2="12" />
        <line x1="3" y1="15" x2="6" y2="15" />
        <line x1="18" y1="9" x2="21" y2="9" />
        <line x1="18" y1="12" x2="21" y2="12" />
        <line x1="18" y1="15" x2="21" y2="15" />
      </svg>
    </button>
  );
}
