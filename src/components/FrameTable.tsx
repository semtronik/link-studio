import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { StatusIndicator } from './StatusIndicator';
import { HexColorized } from './HexColorized';
import type { DecodedFrame, Annotation } from '../types/parser';

interface FrameTableProps {
  frames: DecodedFrame[];
  annotations: Record<string, Annotation>;
  selectedFrameId: string | null;
  onSelectFrame: (frame: DecodedFrame | null) => void;
}

const ANNOTATION_STYLES: Record<Annotation['status'], string> = {
  ok: 'bg-rssi-good/15 text-rssi-good',
  error: 'bg-rssi-bad/15 text-rssi-bad',
  warning: 'bg-yellow-500/15 text-yellow-400',
  linked: 'bg-brand/15 text-brand',
};

function formatTimestamp(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/* Ecart avec la trame precedente. Format aligne sur l'ecran du boitier
 * (format_delta dans ui_screen_monitor.c) pour que la lecture soit
 * identique sur les deux supports :
 *   < 1 s  → "+420ms"
 *   < 10 s → "+2.4s"
 *   < 60 s → "+42s"
 *   >= 60 s → "+3min"
 * null = premiere trame, pas de precedente. */
function formatDelta(deltaMs: number | null): string {
  if (deltaMs == null || deltaMs < 0) return '';
  if (deltaMs < 1000) return `+${Math.round(deltaMs)}ms`;
  if (deltaMs < 10000) {
    const s = Math.floor(deltaMs / 1000);
    const tenths = Math.floor((deltaMs % 1000) / 100);
    return `+${s}.${tenths}s`;
  }
  if (deltaMs < 60000) return `+${Math.floor(deltaMs / 1000)}s`;
  return `+${Math.floor(deltaMs / 60000)}min`;
}

/* ============================================================
 * Ordre d'affichage — chronologique decroissant, non modifiable
 *
 * Le tableau est un outil d'analyse temporelle : l'ecart entre trames
 * consecutives et les curseurs de mesure n'ont de sens que si l'ordre
 * affiche est l'ordre du temps. Aucun tri par colonne n'est propose :
 * un tri RSSI/SNR/taille rendrait les deltas illisibles (deux lignes
 * voisines a l'ecran ne seraient plus voisines dans le temps).
 *
 * Pour isoler des trames sur un critere de qualite, la reponse est un
 * filtre (qui reduit l'ensemble en preservant l'ordre), pas un tri.
 * ============================================================ */

const HEADER_CLASSES =
  'bg-surface-elevated px-4 py-2 text-left text-[12px] font-medium text-text-secondary uppercase tracking-wider border-b border-border';

/* Grille des colonnes de mesure. Partagee entre l'en-tete et la premiere
 * ligne de chaque trame : c'est elle qui aligne les colonnes, et non les
 * colonnes du tableau (une seule <td> par trame, cf. le rendu). Toute
 * modification doit rester coherente entre les deux usages. */
/* La colonne TRAME porte l'horodatage, dont la largeur est incompressible :
 * `minmax(260px, 1fr)` lui garantit ce minimum tout en lui laissant absorber
 * l'espace disponible. En dessous, le conteneur defile horizontalement
 * plutot que d'ecraser les colonnes les unes sur les autres. */
const GRID_CLASSES =
  'grid grid-cols-[minmax(260px,1fr)_80px_140px_140px] items-center gap-4';

/* Apercu payload : les premiers octets suffisent a comparer visuellement
 * des trames voisines et a reperer une anomalie. Le payload complet est
 * dans le panneau de detail, au clic. Toute troncature est signalee par
 * "..." a la suite du dernier octet affiche, jamais coupee en silence. */
const PAYLOAD_PREVIEW_BYTES = 8;

/* Largeur d'un octet rendu ("AB" + espace) en police mono 13px. Sert a
 * deduire combien d'octets tiennent dans la colonne quand la fenetre est
 * trop etroite pour les PAYLOAD_PREVIEW_BYTES.
 *
 * Majoree volontairement : avec un parseur, les octets sont groupes par
 * champ et chaque groupe porte un padding propre, ce qui elargit le rendu
 * au-dela de la largeur d'un octet nu. Sous-estimer ferait deborder la
 * ligne ; surestimer ne coute qu'un octet affiche en moins. */
const BYTE_RENDER_WIDTH = 26;

export function FrameTable({ frames, annotations, selectedFrameId, onSelectFrame }: FrameTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isUserScrolledDown = useRef(false);
  const payloadColRef = useRef<HTMLDivElement>(null);
  const prevFrameCount = useRef(frames.length);

  /* Plus recent en haut. `frames` arrive en ordre d'arrivee croissant :
   * le delta se calcule sur cet ordre (ecart avec la trame precedente
   * dans le temps) AVANT inversion pour l'affichage. */
  const displayedFrames = useMemo(
    () =>
      frames
        .map((frame, i) => ({
          frame,
          deltaMs: i === 0 ? null : (frame.timestamp - frames[i - 1].timestamp) * 1000,
        }))
        .reverse(),
    [frames]
  );

  /* Nombre d'octets affichables, deduit de la largeur reelle de la colonne
   * TRAME. Mesure une seule fois pour tout le tableau (toutes les lignes
   * ont la meme largeur de colonne) plutot qu'un observateur par ligne.
   * La reserve de 24px laisse la place aux "...". */
  const [payloadWidth, setPayloadWidth] = useState(0);

  useEffect(() => {
    const el = payloadColRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      setPayloadWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visibleBytes = useMemo(() => {
    if (payloadWidth <= 0) return PAYLOAD_PREVIEW_BYTES;
    const fit = Math.floor((payloadWidth - 24) / BYTE_RENDER_WIDTH);
    return Math.max(1, Math.min(PAYLOAD_PREVIEW_BYTES, fit));
  }, [payloadWidth]);

  /* Les nouvelles trames s'inserent en haut : le suivi automatique vise
   * donc le haut de la liste, et se desactive des que l'utilisateur
   * descend consulter des trames plus anciennes. */
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 50;
    isUserScrolledDown.current = el.scrollTop > threshold;
  }, []);

  useEffect(() => {
    if (frames.length > prevFrameCount.current && !isUserScrolledDown.current) {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = 0;
      }
    }
    prevFrameCount.current = frames.length;
  }, [frames.length]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-auto rounded-card bg-surface border border-[rgba(255,255,255,0.04)] shadow-subtle"
    >
      {/* Pas de <table> : aucune colonne de tableau ne porte plus la mise en
        * page (les lignes ont deux niveaux, dont un pleine largeur). Garder
        * une table ajoutait un second calcul de largeur, en desaccord avec
        * la grille des que la place manquait — d'ou l'en-tete qui se
        * decalait des lignes. Une seule grille fait foi ici. */}
      {/* Pas de `min-w-max` ici : la grille doit se caler sur la largeur
        * disponible, sinon la colonne TRAME s'etend avec son contenu, la
        * sonde mesure une largeur qui grandit avec le payload et la
        * troncature ne se declenche jamais. */}
      <div className="text-sm">
        {/* Sonde de mesure : reproduit la grille pour donner la largeur
          * reelle de la colonne TRAME sans dependre d'une ligne de donnees,
          * qui peut disparaitre (effacement, filtre). Invisible, hauteur
          * nulle, mais dans le meme flux que les lignes. */}
        <div className={`${GRID_CLASSES} h-0 invisible pointer-events-none px-4`} aria-hidden>
          <div ref={payloadColRef} />
        </div>
        <div className={`${HEADER_CLASSES} ${GRID_CLASSES} sticky top-0 z-10`}>
          <span>Trame</span>
          <span>Octets</span>
          <span>RSSI</span>
          <span>SNR</span>
        </div>

        {displayedFrames.length === 0 ? (
          <div className="px-4 py-8 text-center text-text-muted italic">
            En attente de trames...
          </div>
        ) : (
          displayedFrames.map(({ frame, deltaMs }) => {
            const annotation = annotations[frame.id];
            const byteCount = frame.hex.length / 2;

            /* Un seul bloc par trame : le survol et la selection eclairent
             * les deux lignes visuelles (mesures puis payload) d'un coup. */
            return (
              <div
                key={frame.id}
                className={`px-4 py-2.5 border-b border-[rgba(255,255,255,0.04)] cursor-pointer hover:bg-brand-50 transition-colors duration-200 ${
                  selectedFrameId === frame.id ? 'bg-brand-100' : ''
                }`}
                onClick={() => onSelectFrame(selectedFrameId === frame.id ? null : frame)}
              >
                <div className={GRID_CLASSES}>
                  <span className="font-mono text-xs text-text-muted whitespace-nowrap">
                    {formatTimestamp(frame.timestamp)}
                    {deltaMs != null && (
                      <span className="ml-2 text-text-secondary">{formatDelta(deltaMs)}</span>
                    )}
                  </span>
                  <span className="text-xs text-text-secondary whitespace-nowrap">
                    {byteCount}
                  </span>
                  <span>
                    {frame.rssi != null ? (
                      <StatusIndicator value={frame.rssi} type="rssi" />
                    ) : (
                      <span className="text-text-muted">-</span>
                    )}
                  </span>
                  <span>
                    {frame.snr != null ? (
                      <StatusIndicator value={frame.snr} type="snr" />
                    ) : (
                      <span className="text-text-muted">-</span>
                    )}
                  </span>
                </div>

                {/* Seconde ligne dans la meme grille : le payload est borne
                  * a la colonne TRAME, les colonnes de mesure restent vides. */}
                <div className={`${GRID_CLASSES} mt-1.5`}>
                  {/* `min-w-0` : sans lui, la largeur minimale d'un conteneur
                    * flex est celle de son contenu, et le payload dilaterait
                    * la colonne au lieu d'etre tronque. */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex-1 min-w-0 flex items-center overflow-hidden">
                      <div className="min-w-0 overflow-hidden">
                        <HexColorized
                          hex={frame.hex}
                          fields={frame.decoded?.fields}
                          singleLine
                          maxBytes={visibleBytes}
                        />
                      </div>
                      {byteCount > visibleBytes && (
                        <span
                          className="flex-shrink-0 pl-1 font-mono text-[13px] text-text-muted"
                          title={`${byteCount} octets au total`}
                        >
                          ...
                        </span>
                      )}
                    </div>
                    {annotation && (
                      <span
                        className={`flex-shrink-0 inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${ANNOTATION_STYLES[annotation.status]}`}
                      >
                        {annotation.label}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
