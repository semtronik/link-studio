import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PortInfo } from './useBackend';

const EVENT_PORTS_CHANGED = 'ports_changed';

interface PortsChangedPayload {
  ports: PortInfo[];
  scanning: boolean;
}

// Subscribes to the Rust port scanner; scan pace is driven by SourceSelector via set_scan_pace.
export function usePortDetection(): { ports: PortInfo[]; scanning: boolean } {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [scanning, setScanning] = useState(true);

  useEffect(() => {
    let active = true;

    invoke<PortInfo[]>('get_current_ports')
      .then((initial) => {
        if (!active) return;
        setPorts(initial);
        setScanning(false);
      })
      .catch(() => {
        if (active) setScanning(false);
      });

    const unlistenPromise = listen<PortsChangedPayload>(EVENT_PORTS_CHANGED, (event) => {
      if (!active) return;
      setPorts(event.payload.ports);
      setScanning(event.payload.scanning);
    });

    return () => {
      active = false;
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  return { ports, scanning };
}
