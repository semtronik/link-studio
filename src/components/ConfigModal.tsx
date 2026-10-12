import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '../contexts/ToastContext';
import type { LoRaConfig } from '../hooks/useBackend';

interface ConfigModalProps {
  open: boolean;
  onClose: () => void;
  config: LoRaConfig;
  applyConfig: (params: Partial<LoRaConfig>) => Promise<LoRaConfig>;
}

export function ConfigModal({ open, onClose, config, applyConfig }: ConfigModalProps) {
  const { addToast } = useToast();
  const [freq, setFreq] = useState(config.freq);
  const [freqText, setFreqText] = useState(String(config.freq));
  const [sf, setSf] = useState(config.sf);
  const [bw, setBw] = useState(config.bw);
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [validParams, setValidParams] = useState<{
    bandwidths: number[];
    spreadingFactors: number[];
  } | null>(null);

  // Sync form values ONLY when the modal opens (rising edge of open)
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setFreq(config.freq);
      setFreqText(String(config.freq));
      setSf(config.sf);
      setBw(config.bw);
    }
    prevOpenRef.current = open;
  }, [open, config]);

  const handleClose = useCallback(() => {
    if (sending || closing) return;
    setClosing(true);
    setTimeout(() => {
      onClose();
      setClosing(false);
    }, 150);
  }, [sending, closing, onClose]);

  // Load valid params from Rust
  useEffect(() => {
    if (open && !validParams) {
      invoke<{ bandwidths: number[]; spreadingFactors: number[] }>('get_valid_params')
        .then(setValidParams)
        .catch(() => {});
    }
  }, [open, validParams]);

  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose]);

  const handleApply = async () => {
    setSending(true);
    try {
      await applyConfig({ freq, sf, bw });
      addToast('success', 'Configuration applied');
      handleClose();
    } catch (err) {
      addToast('error', 'Configuration failed', String(err));
    } finally {
      setSending(false);
    }
  };

  if (!open && !closing) return null;

  const bandwidths = validParams?.bandwidths ?? [125.0, 250.0, 500.0];
  const spreadingFactors = validParams?.spreadingFactors ?? [7, 8, 9, 10, 11, 12];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50"
        style={{ animation: closing ? 'modal-overlay-out 150ms ease-out forwards' : 'modal-overlay-in 200ms ease-out' }}
      />

      {/* Card */}
      <div
        className="relative bg-surface rounded-modal shadow-elevated border border-border p-6 w-full max-w-md mx-4"
        style={{ animation: closing ? 'modal-content-out 150ms ease-out forwards' : 'modal-content-in 200ms ease-out' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-semibold text-text-primary">Configure radio</h2>
          <button
            onClick={handleClose}
            disabled={sending}
            className="w-8 h-8 flex items-center justify-center rounded-element text-text-muted hover:text-text-primary hover:bg-overlay transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <label className="text-[13px] text-text-secondary">Frequency</label>
            <input
              type="text"
              inputMode="decimal"
              value={freqText}
              onChange={e => {
                const raw = e.target.value.replace(',', '.');
                setFreqText(raw);
                const n = parseFloat(raw);
                if (!isNaN(n)) setFreq(n);
              }}
              onBlur={() => {
                const clamped = Math.min(960, Math.max(150, freq));
                const rounded = Math.round(clamped * 1000) / 1000;
                setFreq(rounded);
                setFreqText(String(rounded));
              }}
              disabled={sending}
              className="font-mono text-[13px] text-text-primary bg-base px-3 py-1.5 rounded-element border border-border focus:border-brand focus:outline-none w-[140px] text-right disabled:opacity-50"
            />
          </div>

          {/* Spreading Factor */}
          <div className="flex justify-between items-center">
            <label className="text-[13px] text-text-secondary">Spreading Factor</label>
            <select
              value={sf}
              onChange={e => setSf(parseInt(e.target.value))}
              disabled={sending}
              className="font-mono text-[13px] text-text-primary bg-base px-3 py-1.5 rounded-element border border-border focus:border-brand focus:outline-none w-[140px] text-right disabled:opacity-50"
            >
              {spreadingFactors.map(s => <option key={s} value={s}>SF{s}</option>)}
            </select>
          </div>

          {/* Bandwidth */}
          <div className="flex justify-between items-center">
            <label className="text-[13px] text-text-secondary">Bandwidth</label>
            <select
              value={bw}
              onChange={e => setBw(parseFloat(e.target.value))}
              disabled={sending}
              className="font-mono text-[13px] text-text-primary bg-base px-3 py-1.5 rounded-element border border-border focus:border-brand focus:outline-none w-[140px] text-right disabled:opacity-50"
            >
              {bandwidths.map(b => <option key={b} value={b}>{b} kHz</option>)}
            </select>
          </div>

        </div>

        {/* Actions */}
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
            {sending ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                  <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                </svg>
                Sending...
              </span>
            ) : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
