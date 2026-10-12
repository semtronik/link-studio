import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useToast } from '../contexts/ToastContext';
import type { Profile } from '../types/recording';
import { formatSyncWord } from './ProfileCard';

interface ProfileModalProps {
  open: boolean;
  onClose: () => void;
  profile: Profile;
  setProfile: (patch: Profile) => Promise<Profile>;
}

// What set_profile accepts (link/protocol/v1/protocol.md).
const SPREADING_FACTORS = [5, 6, 7, 8, 9, 10, 11, 12];
const BANDWIDTHS_HZ = [62500, 125000, 250000, 500000];
const CODING_RATES = [5, 6, 7, 8];
const FIELDS = ['region', 'freq_hz', 'sf', 'bw_hz', 'cr', 'power_dbm', 'preamble', 'crc_on', 'iq_inverted', 'sync_word', 'rx_gain'] as const;

const INPUT =
  'font-mono text-[13px] text-text-primary bg-base px-3 py-1.5 rounded-element border border-border focus:border-brand focus:outline-none w-[150px] text-right disabled:opacity-50';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-4">
      <div className="min-w-0">
        <label className="text-[13px] text-text-secondary">{label}</label>
        {hint && <div className="text-[11px] text-text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** Integer field typed as text, so a value can be cleared while editing. */
function NumberInput({ value, onChange, min, max, disabled }: {
  value: number; onChange: (v: number) => void; min: number; max: number; disabled: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = parseInt(text, 10);
        const v = isNaN(n) ? value : Math.min(max, Math.max(min, n));
        onChange(v);
        setText(String(v));
      }}
      className={INPUT}
    />
  );
}

export function ProfileModal({ open, onClose, profile, setProfile }: ProfileModalProps) {
  const { addToast } = useToast();
  const [draft, setDraft] = useState<Profile>(profile);
  const [freqText, setFreqText] = useState('');
  const [syncText, setSyncText] = useState('');
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);

  // Reset the form only when the modal opens (rising edge of open).
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setDraft(profile);
      setFreqText(profile.freq_hz != null ? String(profile.freq_hz / 1e6) : '');
      setSyncText(profile.sync_word != null ? formatSyncWord(profile.sync_word) : '');
    }
    prevOpenRef.current = open;
  }, [open, profile]);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const handleClose = useCallback(() => {
    if (sending || closing) return;
    setClosing(true);
    setTimeout(() => {
      onClose();
      setClosing(false);
    }, 150);
  }, [sending, closing, onClose]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose]);

  const handleApply = async () => {
    // Only what changed: the device checks every field it is given.
    const patch: Profile = {};
    for (const key of FIELDS) {
      if (draft[key] !== profile[key]) (patch as Record<string, unknown>)[key] = draft[key];
    }
    if (Object.keys(patch).length === 0) {
      handleClose();
      return;
    }
    setSending(true);
    try {
      await setProfile(patch);
      addToast('success', 'Profile applied', 'A new session has started');
      handleClose();
    } catch (err) {
      addToast('error', 'Profile refused', String(err));
    } finally {
      setSending(false);
    }
  };

  if (!open && !closing) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="absolute inset-0 bg-black/50"
        style={{ animation: closing ? 'modal-overlay-out 150ms ease-out forwards' : 'modal-overlay-in 200ms ease-out' }}
      />

      <div
        className="relative bg-surface rounded-modal shadow-elevated border border-border p-6 w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto"
        style={{ animation: closing ? 'modal-content-out 150ms ease-out forwards' : 'modal-content-in 200ms ease-out' }}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-text-primary">{profile.name ?? 'Radio profile'}</h2>
          <button
            onClick={handleClose}
            disabled={sending}
            className="w-8 h-8 flex items-center justify-center rounded-element text-text-muted hover:text-text-primary hover:bg-overlay transition-colors"
          >
            ✕
          </button>
        </div>
        <p className="text-[12px] text-text-muted mb-5">Applying closes the running session on the device.</p>

        <div className="space-y-3">
          <Row label="Region" hint="How transmissions are assessed; restricts nothing">
            <select value={draft.region} disabled={sending} onChange={(e) => set('region', e.target.value as Profile['region'])} className={INPUT}>
              <option value="EU868">EU868</option>
              <option value="US915">US915</option>
            </select>
          </Row>

          <Row label="Frequency" hint="862 to 930 MHz">
            <input
              type="text"
              inputMode="decimal"
              value={freqText}
              disabled={sending}
              onChange={(e) => setFreqText(e.target.value.replace(',', '.'))}
              onBlur={() => {
                const n = parseFloat(freqText);
                const mhz = isNaN(n) ? (draft.freq_hz ?? 868e6) / 1e6 : Math.min(930, Math.max(862, n));
                const hz = Math.round(mhz * 1e6);
                set('freq_hz', hz);
                setFreqText(String(hz / 1e6));
              }}
              className={INPUT}
            />
          </Row>

          <Row label="Spreading factor">
            <select value={draft.sf} disabled={sending} onChange={(e) => set('sf', parseInt(e.target.value))} className={INPUT}>
              {SPREADING_FACTORS.map((s) => <option key={s} value={s}>SF{s}</option>)}
            </select>
          </Row>

          <Row label="Bandwidth">
            <select value={draft.bw_hz} disabled={sending} onChange={(e) => set('bw_hz', parseInt(e.target.value))} className={INPUT}>
              {BANDWIDTHS_HZ.map((b) => <option key={b} value={b}>{b / 1000} kHz</option>)}
            </select>
          </Row>

          <Row label="Coding rate">
            <select value={draft.cr} disabled={sending} onChange={(e) => set('cr', parseInt(e.target.value))} className={INPUT}>
              {CODING_RATES.map((c) => <option key={c} value={c}>4/{c}</option>)}
            </select>
          </Row>

          <Row label="Power" hint="-9 to 22 dBm, conducted">
            <NumberInput value={draft.power_dbm ?? 14} min={-9} max={22} disabled={sending} onChange={(v) => set('power_dbm', v)} />
          </Row>

          <Row label="Preamble" hint="Symbols">
            <NumberInput value={draft.preamble ?? 8} min={1} max={65535} disabled={sending} onChange={(v) => set('preamble', v)} />
          </Row>

          <Row label="Sync word" hint="0x12 private, 0x34 public">
            <input
              type="text"
              value={syncText}
              disabled={sending}
              onChange={(e) => setSyncText(e.target.value)}
              onBlur={() => {
                const n = parseInt(syncText.replace(/^0x/i, ''), 16);
                const v = isNaN(n) ? (draft.sync_word ?? 0x12) : Math.min(255, Math.max(0, n));
                set('sync_word', v);
                setSyncText(formatSyncWord(v));
              }}
              className={INPUT}
            />
          </Row>

          <Row label="CRC" hint="Sent with our frames">
            <select value={draft.crc_on ? 'on' : 'off'} disabled={sending} onChange={(e) => set('crc_on', e.target.value === 'on')} className={INPUT}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </Row>

          <Row label="IQ" hint="Inverted for LoRaWAN downlinks">
            <select value={draft.iq_inverted ? 'inverted' : 'standard'} disabled={sending} onChange={(e) => set('iq_inverted', e.target.value === 'inverted')} className={INPUT}>
              <option value="standard">Standard</option>
              <option value="inverted">Inverted</option>
            </select>
          </Row>

          <Row label="RX gain">
            <select value={draft.rx_gain} disabled={sending} onChange={(e) => set('rx_gain', e.target.value as Profile['rx_gain'])} className={INPUT}>
              <option value="saving">Power saving</option>
              <option value="boosted">Boosted</option>
            </select>
          </Row>
        </div>

        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-border">
          <button
            onClick={handleClose}
            disabled={sending}
            className="px-4 py-2 text-sm text-text-secondary bg-transparent border border-border rounded-element hover:bg-overlay transition-all duration-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={sending}
            className="px-4 py-2 text-sm font-semibold bg-brand text-brand-dark rounded-element hover:bg-brand-hover transition-all duration-200 disabled:opacity-50 min-w-[100px]"
          >
            {sending ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
