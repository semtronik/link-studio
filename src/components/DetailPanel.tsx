import { useState, Fragment } from 'react';
import { HexColorized } from './HexColorized';
import type { DecodedFrame, Field, Annotation } from '../types/parser';

interface DetailPanelProps {
  /* null = aucune trame selectionnee. Le panneau reste monte et affiche
   * un etat vide : sa largeur est reservee en permanence pour que le
   * tableau ne soit pas redimensionne a chaque selection. */
  frame: DecodedFrame | null;
  annotation?: Annotation;
}

const ANNOTATION_BADGE: Record<Annotation['status'], string> = {
  ok: 'bg-rssi-good/15 text-rssi-good border-rssi-good/30',
  error: 'bg-rssi-bad/15 text-rssi-bad border-rssi-bad/30',
  warning: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  linked: 'bg-brand/15 text-brand border-brand/30',
};

function formatTimestamp(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function ParsedFieldsGrid({ fields, highlightedField, onHighlightField }: {
  fields: Field[];
  highlightedField: string | null;
  onHighlightField: (name: string | null) => void;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
      {fields.map((field, idx) => {
        const isHighlighted = highlightedField === field.name;
        return (
          <Fragment key={idx}>
            <span
              className={`text-text-muted cursor-pointer transition-colors duration-200 ${isHighlighted ? 'text-text-primary font-medium' : 'hover:text-text-secondary'}`}
              onClick={() => onHighlightField(isHighlighted ? null : field.name)}
            >
              {field.name}
            </span>
            <span
              className={`font-mono text-text-primary cursor-pointer transition-colors duration-200 ${isHighlighted ? 'text-brand' : ''}`}
              onClick={() => onHighlightField(isHighlighted ? null : field.name)}
            >
              {String(field.value)}{field.unit ? ` ${field.unit}` : ''}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

/* Empile sous la liste : hauteur fixe, pleine largeur. Cote a cote
 * (conteneur >= 1140px, soit la largeur qu'il faut pour afficher toutes
 * les colonnes du tableau ET le panneau) : hauteur alignee sur la liste,
 * largeur a 40% du conteneur, bornee entre 420 et 640px. Le plafond est
 * volontaire : au-dela de ~24 octets par ligne, un dump hexa devient plus
 * difficile a parcourir, pas plus lisible. Le plancher garantit une ligne
 * exploitable (~16 octets).
 * Dans les deux cas la zone est reservee en permanence, y compris sans
 * selection — la liste ne se redimensionne jamais au clic.
 * Le seuil doit rester identique a celui de FrameViewer. */
const PANEL_CLASSES =
  'h-[260px] @[1140px]:h-auto @[1140px]:w-[40%] @[1140px]:min-w-[420px] @[1140px]:max-w-[640px] flex-shrink-0 overflow-y-auto bg-surface rounded-card border border-[rgba(255,255,255,0.04)] shadow-subtle p-4';

export function DetailPanel({ frame, annotation }: DetailPanelProps) {
  const [highlightedField, setHighlightedField] = useState<string | null>(null);

  if (!frame) {
    return (
      <div className={`${PANEL_CLASSES} flex items-center justify-center`}>
        <p className="text-[12px] text-text-muted text-center">
          Selectionnez une trame<br />pour voir son detail
        </p>
      </div>
    );
  }

  const fields = frame.decoded?.fields || [];

  /* Un champ qui couvre tout le payload et se contente d'en repeter les
   * octets n'ajoute rien au bloc hexa colorise juste au-dessus — c'est le
   * cas du champ unique "Data" du parseur Raw. On l'ecarte de la liste
   * pour ne pas afficher deux fois le meme dump. */
  const byteCount = frame.hex.length / 2;
  const listedFields = fields.filter(field => {
    const [start, end] = field.bytes;
    const coversAll = start === 0 && end >= byteCount;
    if (!coversAll) return true;
    const normalized = String(field.value).replace(/[\s:]/g, '').toUpperCase();
    return normalized !== frame.hex.toUpperCase();
  });

  return (
    <div
      key={frame.id}
      className={`${PANEL_CLASSES} animate-[detail-slide-in_200ms_ease-out]`}
    >
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-[13px] font-medium text-text-secondary uppercase tracking-wider">
          Detail trame — {formatTimestamp(frame.timestamp)}
        </h3>
        {annotation && (
          <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${ANNOTATION_BADGE[annotation.status]}`}>
            {annotation.label}
          </span>
        )}
      </div>

      {frame.decodeError && (
        <div className="text-rssi-bad text-xs mb-3">
          Erreur : {frame.decodeError}
        </div>
      )}

      {/* Empile sous la liste, le panneau est large mais bas : hex et champs
        * cote a cote. En colonne de droite il est etroit et haut : ils
        * s'empilent. Le seuil est celui de la disposition generale. */}
      <div className="flex gap-6 @[1140px]:flex-col @[1140px]:gap-4">
        <div className="flex-1 min-w-0 @[1140px]:flex-none">
          <HexColorized
            hex={frame.hex}
            fields={fields}
            highlightedField={highlightedField}
            onHighlightField={setHighlightedField}
            showLegend={true}
          />
        </div>

        {listedFields.length > 0 && (
          /* Le filet ne separe qu'en mode empile : cote a cote, l'ecart
            * horizontal suffit. */
          <div className="flex-1 min-w-0 @[1140px]:flex-none @[1140px]:pt-4 @[1140px]:border-t @[1140px]:border-[rgba(255,255,255,0.06)]">
            <ParsedFieldsGrid
              fields={listedFields}
              highlightedField={highlightedField}
              onHighlightField={setHighlightedField}
            />
          </div>
        )}
      </div>
    </div>
  );
}
