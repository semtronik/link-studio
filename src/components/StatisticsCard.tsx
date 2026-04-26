import { useEffect, useState } from 'react';
import { useSerialContext } from '../contexts/SerialContext';
import { useFrameContext } from '../contexts/FrameContext';
import { ProgressiveValue } from './ProgressiveValue';

/* Formate un délai en secondes en chaîne lisible :
 *   < 60 s    → "il y a Xs"
 *   < 60 min  → "il y a X min"
 *   sinon     → "il y a Xh Ymin"
 * Renvoie aussi un niveau de gravité utilisé pour la couleur :
 *   normal (< 5 min)   → text-text-secondary
 *   warning (< 30 min) → text-amber-500
 *   alert (>= 30 min)  → text-red-500
 */
function formatLastFrameAge(ageSeconds: number): { text: string; level: 'normal' | 'warning' | 'alert' } {
  let level: 'normal' | 'warning' | 'alert' = 'normal';
  if (ageSeconds >= 1800) level = 'alert';
  else if (ageSeconds >= 300) level = 'warning';

  let text: string;
  if (ageSeconds < 60) {
    text = `il y a ${Math.floor(ageSeconds)}s`;
  } else if (ageSeconds < 3600) {
    text = `il y a ${Math.floor(ageSeconds / 60)} min`;
  } else {
    const h = Math.floor(ageSeconds / 3600);
    const m = Math.floor((ageSeconds % 3600) / 60);
    text = `il y a ${h}h ${m}min`;
  }
  return { text, level };
}

export function StatisticsCard() {
  const { connected, stats } = useSerialContext();
  const { frames } = useFrameContext();

  /* Tick d'horloge pour forcer un re-render périodique du compteur
   * "dernière trame il y a X". Toutes les 10 s suffit pour la précision
   * affichée (minutes / secondes). */
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTickNow(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);

  if (!connected) {
    return (
      <div className="bg-surface rounded-card p-4 text-center text-text-muted border border-border text-[13px]">
        Connectez un appareil pour voir les statistiques
      </div>
    );
  }

  /* Timestamp de la dernière trame reçue. Frame.timestamp est en secondes
   * (epoch). Si aucune trame, on n'affiche pas la ligne. */
  const lastFrame = frames.length > 0 ? frames[frames.length - 1] : null;
  const lastFrameAge = lastFrame ? (tickNow / 1000) - lastFrame.timestamp : null;
  const lastFrameDisplay = lastFrameAge != null ? formatLastFrameAge(lastFrameAge) : null;
  const ageColorClass =
    lastFrameDisplay?.level === 'alert' ? 'text-red-500'
    : lastFrameDisplay?.level === 'warning' ? 'text-amber-500'
    : 'text-text-secondary';

  return (
    <div className="bg-surface/80 backdrop-blur-sm rounded-card shadow-subtle p-4 border border-border/50">
      <h2 className="text-[13px] font-medium text-text-secondary uppercase tracking-wider mb-2">
        Statistiques
      </h2>

      <div className="divide-y divide-border/50">
        <div className="flex justify-between items-center py-2">
          <span className="text-[13px] text-text-secondary">RSSI moyen</span>
          {stats.avgRssi != null ? (
            <ProgressiveValue value={stats.avgRssi} type="rssi" decimals={0} unit="dBm" />
          ) : (
            <span className="font-mono text-[13px] text-text-muted">--</span>
          )}
        </div>

        <div className="flex justify-between items-center py-2">
          <span className="text-[13px] text-text-secondary">SNR moyen</span>
          {stats.avgSnr != null ? (
            <ProgressiveValue value={stats.avgSnr} type="snr" decimals={1} unit="dB" />
          ) : (
            <span className="font-mono text-[13px] text-text-muted">--</span>
          )}
        </div>

        {lastFrameDisplay && (
          <div className="flex justify-between items-center py-2">
            <span className="text-[13px] text-text-secondary">Dernière trame</span>
            <span className={`text-[13px] ${ageColorClass}`}>
              {lastFrameDisplay.text}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
