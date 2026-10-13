import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePortDetection } from '../hooks/usePortDetection';
import type { PortInfo, DataSource } from '../hooks/useBackend';

interface SourceSelectorProps {
  dataSource: DataSource;
  currentPort: string | null;
  currentPortInfo: PortInfo | null;
  connected: boolean;
  connecting: boolean;
  replayFilename: string | null;
  onConnect: (port: string) => void;
  onDisconnect: () => void;
  onLoadFile: (file: File) => void;
  onCloseReplay: () => void;
}

export function SourceSelector({
  dataSource,
  currentPort,
  currentPortInfo,
  connected,
  connecting,
  replayFilename,
  onConnect,
  onDisconnect,
  onLoadFile,
  onCloseReplay,
}: SourceSelectorProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { ports, scanning } = usePortDetection();

  // Scanner runs fast (2 s) while the dropdown is open or no source is selected, slow (5 s) otherwise.
  useEffect(() => {
    const active = open || (!connected && dataSource !== 'replay');
    invoke('set_scan_pace', { active }).catch(() => {});
  }, [open, connected, dataSource]);

  useEffect(() => {
    if (open) {
      invoke('refresh_ports_now').catch(() => {});
    }
  }, [open]);

  const closeDropdown = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
      setFocusIndex(-1);
    }, 100);
  }, [closing]);

  // Toggle dropdown
  const toggleDropdown = useCallback(() => {
    if (connecting) return;
    if (open) {
      closeDropdown();
    } else {
      setOpen(true);
      setFocusIndex(-1);
    }
  }, [open, connecting, closeDropdown]);

  // Click outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, closeDropdown]);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDropdown();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, closeDropdown]);

  // Keyboard navigation in dropdown
  const itemCount = ports.length + 1; // ports + file action
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIndex(prev => (prev + 1) % itemCount);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIndex(prev => (prev - 1 + itemCount) % itemCount);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (focusIndex >= 0 && focusIndex < ports.length) {
          const port = ports[focusIndex];
          if (port.identifying || port.busy) return;
          if (port.path !== currentPort || !connected) {
            handlePortClick(port.path);
          }
        } else if (focusIndex === ports.length) {
          handleFileClick();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, focusIndex, itemCount, ports, currentPort, connected]);

  // Port click → connect
  const handlePortClick = useCallback((portPath: string) => {
    closeDropdown();
    onConnect(portPath);
  }, [closeDropdown, onConnect]);

  // File click
  const handleFileClick = useCallback(() => {
    closeDropdown();
    fileInputRef.current?.click();
  }, [closeDropdown]);

  // File input change
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onLoadFile(file);
      e.target.value = '';
    }
  };

  // Eject/close button handler (stopPropagation to not toggle dropdown)
  const handleEject = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDisconnect();
  }, [onDisconnect]);

  const handleCloseReplay = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onCloseReplay();
  }, [onCloseReplay]);

  // The identified device if any, else what the OS driver reports.
  const portPrimaryLabel = (port: PortInfo): string | null => {
    const fw = port.firmware;
    if (fw) {
      if (fw.kind === 'linkLr') return 'Link-LR';
      if (fw.kind === 'lft') return 'LFT prototype — use lft-app 1.0.0';
      return [fw.product, fw.model].filter(Boolean).join(' ') || 'Unknown device';
    }
    const parts: string[] = [];
    if (port.manufacturer) parts.push(port.manufacturer);
    if (port.product) parts.push(port.product);
    return parts.join(' — ') || null;
  };

  const portVidPid = (port: PortInfo) => {
    if (port.firmware?.mac) return `MAC:${port.firmware.mac}`;
    if (port.vid && port.pid) return `VID:${port.vid} · PID:${port.pid}`;
    return null;
  };

  // Falls back to the scanned list, which carries the firmware identity when currentPortInfo is null.
  const connectedLabel = () => {
    if (!currentPort) return '';
    const info = currentPortInfo
      ?? ports.find(p => p.path === currentPort)
      ?? null;
    const label = info ? portPrimaryLabel(info) : null;
    return label ? `${currentPort} — ${label}` : currentPort;
  };

  // --- RENDER TRIGGER ---
  const renderTrigger = () => {
    // Connecting state
    if (connecting) {
      return (
        <button
          ref={triggerRef}
          className="h-8 px-3 rounded-element flex items-center gap-2 bg-brand/10 border border-brand/30 pointer-events-none transition-all duration-200"
          aria-label="Connecting"
        >
          <svg className="animate-spin w-3.5 h-3.5 text-brand" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
            <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
          </svg>
          <span className="text-sm text-brand/80 font-medium">Connecting to {currentPort}…</span>
        </button>
      );
    }

    // Connected (live)
    if (connected && dataSource === 'live') {
      return (
        <div className="h-8 inline-flex items-center gap-1 pl-3 pr-1 rounded-element bg-rssi-good/10 border border-rssi-good/30 hover:bg-rssi-good/15 transition-all duration-200">
          <button
            ref={triggerRef}
            onClick={toggleDropdown}
            className="flex items-center gap-2 cursor-pointer"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label="Select a data source"
          >
            <span className="w-2 h-2 bg-rssi-good rounded-full animate-pulse" />
            <span className="text-[#F1F5F9] font-mono text-[13px] truncate max-w-[200px]">{connectedLabel()}</span>
          </button>
          <button
            onClick={handleEject}
            className="w-6 h-6 flex items-center justify-center rounded-element text-[#F1F5F9]/60 hover:text-rssi-bad hover:bg-rssi-bad/10 transition-colors duration-200"
            title="Disconnect"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M12 5l-7 8h14l-7-8zm-7 10h14v2H5v-2z" />
            </svg>
          </button>
        </div>
      );
    }

    // Replay mode
    if (dataSource === 'replay') {
      return (
        <div className="h-8 inline-flex items-center gap-1 pl-3 pr-1 rounded-element bg-brand/10 border border-brand/20 hover:bg-brand/15 transition-all duration-200">
          <button
            ref={triggerRef}
            onClick={toggleDropdown}
            className="flex items-center gap-2 cursor-pointer"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label="Select a data source"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-brand/70">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="text-brand text-[13px] truncate max-w-[200px]">{replayFilename}</span>
          </button>
          <button
            onClick={handleCloseReplay}
            className="w-6 h-6 flex items-center justify-center rounded-element text-brand/60 hover:text-rssi-bad hover:bg-rssi-bad/10 transition-colors duration-200"
            title="Close replay"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      );
    }

    // Disconnected (idle)
    return (
      <button
        ref={triggerRef}
        onClick={toggleDropdown}
        className="h-8 px-3 rounded-element flex items-center gap-2 bg-brand hover:bg-brand-hover text-brand-dark font-semibold text-sm transition-all duration-200 cursor-pointer"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Select a data source"
      >
        {/* Diamond icon */}
        <svg viewBox="0 0 12 12" className="w-3 h-3">
          <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span>Select a source</span>
        {/* Chevron */}
        <svg viewBox="0 0 12 12" className="w-3 h-3 opacity-70">
          <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    );
  };

  // --- RENDER DROPDOWN ---
  const renderDropdown = () => {
    if (!open && !closing) return null;

    return (
      <div
        ref={listRef}
        role="listbox"
        className="absolute top-[calc(100%+4px)] left-0 z-50 min-w-[320px] max-w-[400px] bg-surface border border-border rounded-card shadow-elevated py-2"
        style={{
          animation: closing
            ? 'dropdown-out 100ms ease-out forwards'
            : 'dropdown-in 150ms ease-out',
        }}
      >
        {/* Section header */}
        <div className="px-4 py-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
            Serial ports
          </span>
          {scanning && (
            <span className="flex items-center gap-1.5">
              <svg className="animate-spin w-3 h-3 text-text-muted" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
              </svg>
              <span className="text-[11px] text-text-muted">Scanning…</span>
            </span>
          )}
        </div>

        {/* Port list or empty state */}
        {ports.length === 0 ? (
          <div className="py-6 px-4 text-center">
            <div className="text-[13px] text-text-muted">No serial port detected</div>
            <div className="text-[12px] text-text-muted mt-1">Connect your device over USB</div>
          </div>
        ) : (
          ports.map((port, index) => {
            const isActive = connected && port.path === currentPort;
            const isConnecting = connecting && port.path === currentPort;
            const isFocused = focusIndex === index;
            const subtitle = portPrimaryLabel(port);
            const vidpid = portVidPid(port);

            // Active port (connected)
            if (isActive) {
              return (
                <div
                  key={port.path}
                  role="option"
                  aria-selected
                  className="px-4 py-2.5 bg-brand-100 border-l-[3px] border-l-brand cursor-default"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 bg-rssi-good rounded-full animate-pulse" />
                    <span className="font-mono text-[13px] text-brand font-medium">{port.path}</span>
                  </div>
                  {subtitle && <div className="text-[12px] text-text-secondary ml-4 mt-0.5">{subtitle}</div>}
                  {vidpid && <div className="font-mono text-[11px] text-text-muted ml-4 mt-0.5">{vidpid}</div>}
                </div>
              );
            }

            // Connecting port
            if (isConnecting) {
              return (
                <div
                  key={port.path}
                  role="option"
                  className="px-4 py-2.5 bg-brand-50 opacity-80"
                >
                  <div className="flex items-center gap-2">
                    <svg className="animate-spin w-3.5 h-3.5 text-brand" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                    </svg>
                    <span className="font-mono text-[13px] text-brand font-medium">{port.path}</span>
                  </div>
                  {subtitle && <div className="text-[12px] text-text-secondary ml-4 mt-0.5">{subtitle}</div>}
                  {vidpid && <div className="font-mono text-[11px] text-text-muted ml-4 mt-0.5">{vidpid}</div>}
                </div>
              );
            }

            // Not selectable until identified, so we never connect before the firmware is ready.
            if (port.identifying) {
              return (
                <div
                  key={port.path}
                  role="option"
                  aria-selected={false}
                  aria-busy
                  className="px-4 py-2.5 cursor-wait opacity-70"
                >
                  <div className="flex items-center gap-2">
                    <svg className="animate-spin w-3.5 h-3.5 text-text-muted" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                    </svg>
                    <span className="font-mono text-[13px] text-text-primary font-medium">{port.path}</span>
                  </div>
                  <div className="text-[12px] text-text-muted ml-4 mt-0.5 italic">Identifying…</div>
                </div>
              );
            }

            // Held by another app: connecting would fail, so show why instead.
            if (port.busy) {
              return (
                <div
                  key={port.path}
                  role="option"
                  aria-selected={false}
                  aria-disabled
                  className="px-4 py-2.5 cursor-not-allowed opacity-60"
                  title="Port in use by another application"
                >
                  <div className="flex items-center gap-2">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 text-text-muted">
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0110 0v4" />
                    </svg>
                    <span className="font-mono text-[13px] text-text-muted font-medium">{port.path}</span>
                  </div>
                  <div className="text-[12px] text-text-muted ml-4 mt-0.5">In use by another application</div>
                </div>
              );
            }

            // Available port
            return (
              <div
                key={port.path}
                role="option"
                aria-selected={false}
                onClick={() => handlePortClick(port.path)}
                className={`px-4 py-2.5 cursor-pointer transition-colors duration-150 ${
                  isFocused ? 'bg-brand-50' : 'hover:bg-brand-50'
                } ${connecting ? 'pointer-events-none opacity-50' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full border border-text-muted" />
                  <span className="font-mono text-[13px] text-text-primary font-medium">{port.path}</span>
                </div>
                {subtitle && <div className="text-[12px] text-text-secondary ml-4 mt-0.5">{subtitle}</div>}
                {vidpid && <div className="font-mono text-[11px] text-text-muted ml-4 mt-0.5">{vidpid}</div>}
              </div>
            );
          })
        )}

        {/* Divider */}
        <div className="border-t border-border/50 my-1" />

        {/* File action */}
        <div
          role="option"
          aria-selected={false}
          onClick={handleFileClick}
          className={`px-4 py-2.5 cursor-pointer flex items-center gap-3 transition-colors duration-150 ${
            focusIndex === ports.length ? 'bg-brand-50' : 'hover:bg-brand-50'
          } group`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-text-secondary group-hover:text-brand transition-colors">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="text-[13px] text-text-secondary group-hover:text-brand transition-colors">
            Open a recording (.jsonl)
          </span>
        </div>
      </div>
    );
  };

  return (
    <div ref={wrapperRef} className="relative">
      {renderTrigger()}
      {renderDropdown()}
      <input
        ref={fileInputRef}
        type="file"
        accept=".jsonl"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
}
