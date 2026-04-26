import { useCallback, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useFirmwareUpdater } from '../hooks/useFirmwareUpdater';

export function FirmwareFlasher() {
  const {
    deviceVersion,
    isFlashing,
    flashProgress,
    flashStatus,
    error,
    fetchDeviceVersion,
    flashFirmwareFromPath,
  } = useFirmwareUpdater();

  // Recuperer la version au montage
  useEffect(() => {
    fetchDeviceVersion();
  }, [fetchDeviceVersion]);

  const handlePickAndFlash = useCallback(async () => {
    const path = await open({
      title: 'Choisir un firmware (.bin)',
      filters: [{ name: 'Firmware', extensions: ['bin'] }],
      multiple: false,
      directory: false,
    });
    if (!path) return;
    await flashFirmwareFromPath(path);
  }, [flashFirmwareFromPath]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">Firmware</span>
        {deviceVersion && (
          <span className="text-[11px] font-mono text-text-muted">{deviceVersion}</span>
        )}
      </div>

      <button
        onClick={handlePickAndFlash}
        disabled={isFlashing}
        className="w-full px-3 py-2 text-sm rounded-element border border-border text-text-secondary hover:text-brand hover:border-brand hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
      >
        {isFlashing ? 'Mise a jour en cours...' : 'Flash firmware (.bin)'}
      </button>

      {isFlashing && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-overlay overflow-hidden">
            <div
              className="h-full rounded-full bg-brand transition-all duration-300"
              style={{ width: `${Math.min(flashProgress, 100)}%` }}
            />
          </div>
          <p className="text-[11px] text-text-muted">
            {flashStatus === 'checking' && 'Verification du device...'}
            {flashStatus === 'flashing' && `${Math.round(flashProgress)}%`}
            {flashStatus === 'rebooting' && 'Redemarrage du LFT...'}
          </p>
        </div>
      )}

      {flashStatus === 'done' && (
        <p className="text-[11px] text-rssi-good">
          Firmware mis a jour{deviceVersion ? ` (${deviceVersion})` : ''}
        </p>
      )}

      {error && (
        <p className="text-[11px] text-rssi-bad">{error}</p>
      )}
    </div>
  );
}
