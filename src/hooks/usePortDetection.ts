import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PortInfo } from './useBackend';

const EVENT_PORTS_CHANGED = 'ports_changed';

interface PortsChangedPayload {
  ports: PortInfo[];
  scanning: boolean;
}

/**
 * S'abonne au scanner de ports côté Rust.
 *
 * Le scanner tourne en continu côté backend (boucle de fond). Ce hook :
 *   1. Récupère l'état courant au mount via `get_current_ports`.
 *   2. Écoute l'event Tauri `ports_changed` pour toute mise à jour.
 *
 * Aucun polling React. Le rythme de scan (2 s actif / 5 s veille) est
 * piloté séparément par `SourceSelector` via `set_scan_pace`.
 */
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
