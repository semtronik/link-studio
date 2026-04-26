import { useState, useCallback } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';

interface FlashProgress {
  status: string;
  bytesSent: number;
  totalBytes: number;
  percent: number;
}

export type FirmwareStatus = 'idle' | 'checking' | 'flashing' | 'rebooting' | 'done' | 'error';

export function useFirmwareUpdater() {
  const [isFlashing, setIsFlashing] = useState(false);
  const [flashProgress, setFlashProgress] = useState(0);
  const [flashStatus, setFlashStatus] = useState<FirmwareStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [deviceVersion, setDeviceVersion] = useState<string | null>(null);

  const fetchDeviceVersion = useCallback(async (): Promise<string | null> => {
    try {
      const version = await invoke<string | null>('get_device_version');
      setDeviceVersion(version);
      return version;
    } catch {
      setDeviceVersion(null);
      return null;
    }
  }, []);

  const flashFirmwareFromPath = useCallback(async (firmwarePath: string) => {
    setIsFlashing(true);
    setError(null);
    setFlashProgress(0);

    try {
      setFlashStatus('checking');
      const version = await fetchDeviceVersion();
      if (version === null) {
        setError("Ce device ne supporte pas la mise a jour OTA");
        setFlashStatus('error');
        setIsFlashing(false);
        return;
      }

      setFlashStatus('flashing');
      const progressChannel = new Channel<FlashProgress>();
      progressChannel.onmessage = (progress) => {
        setFlashProgress(progress.percent);
        if (progress.status === 'rebooting') {
          setFlashStatus('rebooting');
        } else if (progress.status === 'done') {
          setFlashStatus('done');
        }
      };

      await invoke('flash_firmware', {
        firmwarePath,
        onProgress: progressChannel,
      });

      setFlashStatus('done');
      setFlashProgress(100);

      setTimeout(() => { fetchDeviceVersion(); }, 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFlashStatus('error');
    } finally {
      setIsFlashing(false);
    }
  }, [fetchDeviceVersion]);

  return {
    deviceVersion,
    isFlashing,
    flashProgress,
    flashStatus,
    error,
    fetchDeviceVersion,
    flashFirmwareFromPath,
  } as const;
}
