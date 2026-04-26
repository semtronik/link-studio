import { useState, Fragment } from 'react';
import { HexColorized } from './HexColorized';
import type { DecodedFrame, Field, Annotation } from '../types/parser';

interface DetailPanelProps {
  frame: DecodedFrame;
  annotation?: Annotation;
  visible: boolean;
  onAnimationEnd?: () => void;
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

export function DetailPanel({ frame, annotation, visible, onAnimationEnd }: DetailPanelProps) {
  const [highlightedField, setHighlightedField] = useState<string | null>(null);
  const fields = frame.decoded?.fields || [];

  const animationClass = visible
    ? 'animate-[detail-slide-in_300ms_ease-out]'
    : 'animate-[detail-slide-out_200ms_ease-out_forwards]';

  return (
    <div
      className={`bg-surface rounded-card border border-[rgba(255,255,255,0.04)] shadow-subtle p-4 ${animationClass}`}
      onAnimationEnd={() => { if (!visible) onAnimationEnd?.(); }}
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

      <div className="flex gap-6">
        {/* Left: Hex colorized with legend */}
        <div className="flex-1">
          <HexColorized
            hex={frame.hex}
            fields={fields}
            highlightedField={highlightedField}
            onHighlightField={setHighlightedField}
            showLegend={true}
          />
        </div>

        {/* Right: Parsed fields grid */}
        {fields.length > 0 && (
          <div className="flex-1">
            <ParsedFieldsGrid
              fields={fields}
              highlightedField={highlightedField}
              onHighlightField={setHighlightedField}
            />
          </div>
        )}
      </div>
    </div>
  );
}
