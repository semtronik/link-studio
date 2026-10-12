import { useState } from 'react';

interface TransmitBarProps {
  /** Resolves true once the device has the frame on air. */
  onTransmit: (hex: string) => Promise<boolean>;
}

/** Payload as typed: spaces, colons and a 0x prefix are tolerated. */
function normalizeHex(text: string): string {
  return text.replace(/0x/gi, '').replace(/[\s:,-]/g, '').toUpperCase();
}

export function TransmitBar({ onTransmit }: TransmitBarProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const hex = normalizeHex(text);
  const bytes = hex.length / 2;
  let error: string | null = null;
  if (hex && !/^[0-9A-F]*$/.test(hex)) error = 'Hex digits only';
  else if (hex.length % 2 !== 0) error = 'Odd number of digits';
  else if (bytes > 255) error = 'At most 255 bytes';

  const send = async () => {
    if (!hex || error || sending) return;
    setSending(true);
    await onTransmit(hex);
    setSending(false);
  };

  return (
    <div className="flex items-center gap-3 flex-shrink-0">
      <span className="text-[12px] font-medium text-text-secondary uppercase tracking-wider">Transmit</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        placeholder="Payload in hex, e.g. 01 02 A0 FF"
        spellCheck={false}
        className="flex-1 min-w-0 font-mono text-[13px] text-text-primary bg-base px-3 py-1.5 rounded-element border border-border focus:border-brand focus:outline-none"
      />
      <span className={`text-[12px] whitespace-nowrap ${error ? 'text-rssi-bad' : 'text-text-muted'}`}>
        {error ?? (hex ? `${bytes} B` : '')}
      </span>
      <button
        onClick={send}
        disabled={!hex || !!error || sending}
        className="px-4 py-1.5 text-sm font-semibold bg-brand text-brand-dark rounded-element hover:bg-brand-hover transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}
