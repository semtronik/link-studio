import { useState, Fragment } from 'react';
import { HexColorized } from './HexColorized';
import { formatToa, marginClass } from '../utils/journal';
import type { DecodedFrame, Field, Annotation } from '../types/parser';

interface DetailPanelProps {
  /* null still renders the panel, so the table never resizes on selection. */
  frame: DecodedFrame | null;
  annotation?: Annotation;
  /** Set while the journal is live: puts the payload on air again. */
  onReplay?: (hex: string) => void;
}

const STATUS_TEXT: Record<string, string> = {
  ok: 'Received',
  crc_err: 'CRC error — payload corrupt',
  header_err: 'Header error',
  incomplete: 'Incomplete — header passed, frame did not follow',
};

/* Device measurements, in the order of recording.md; absent ones are skipped. */
function measurements(frame: DecodedFrame): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const line = frame.line;
  if (line.type === 'rx') {
    out.push(['Status', STATUS_TEXT[line.status] ?? line.status]);
    if (line.rssi_dbm != null) out.push(['RSSI', `${line.rssi_dbm} dBm`]);
    if (line.signal_dbm != null) out.push(['Signal', `${line.signal_dbm} dBm`]);
    if (line.snr_db != null) out.push(['SNR', `${line.snr_db} dB`]);
    if (frame.margin != null) out.push(['Margin', `${frame.margin.toFixed(1)} dB, ${marginClass(frame.margin)}`]);
    if (line.noise_dbm != null) out.push(['Noise before', `${line.noise_dbm} dBm`]);
    if (line.inst_min_dbm != null && line.inst_max_dbm != null) {
      out.push(['During frame', `${line.inst_min_dbm} to ${line.inst_max_dbm} dBm (${line.inst_n ?? '?'} readings)`]);
    }
    if (line.freq_err_hz != null) out.push(['Frequency offset', `${line.freq_err_hz} Hz`]);
    if (line.cr != null) out.push(['Coding rate', `4/${line.cr}`]);
    if (line.crc_on != null) out.push(['CRC', line.crc_on ? 'on' : 'off']);
  } else if (line.type === 'tx') {
    out.push(['Transmission', line.result === 'ok' ? 'Sent' : line.result]);
  }
  if (frame.toaMs != null) out.push(['Time on air', formatToa(frame.toaMs)]);
  return out;
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

/* The 1140px breakpoint must match FrameViewer. Max width is deliberate:
 * beyond ~24 bytes per line a hex dump gets harder to scan. */
const PANEL_CLASSES =
  'h-[260px] @[1140px]:h-auto @[1140px]:w-[40%] @[1140px]:min-w-[420px] @[1140px]:max-w-[640px] flex-shrink-0 overflow-y-auto bg-surface rounded-card border border-[rgba(255,255,255,0.04)] shadow-subtle p-4';

export function DetailPanel({ frame, annotation, onReplay }: DetailPanelProps) {
  const [highlightedField, setHighlightedField] = useState<string | null>(null);

  if (!frame) {
    return (
      <div className={`${PANEL_CLASSES} flex items-center justify-center`}>
        <p className="text-[12px] text-text-muted text-center">
          Select a frame<br />to see its details
        </p>
      </div>
    );
  }

  const fields = frame.decoded?.fields || [];

  /* Hide a field that merely repeats the whole payload (the Raw parser's "Data"). */
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
      <div className="flex items-center gap-3 mb-2">
        <h3 className="text-[13px] font-medium text-text-secondary uppercase tracking-wider">
          {frame.kind === 'tx' ? 'Transmission' : 'Frame'} — {formatTimestamp(frame.timestamp)}
        </h3>
        {annotation && (
          <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${ANNOTATION_BADGE[annotation.status]}`}>
            {annotation.label}
          </span>
        )}
        {onReplay && byteCount > 0 && frame.status !== 'crc_err' && (
          <button
            onClick={() => onReplay(frame.hex)}
            title="Transmit this payload again"
            className="ml-auto px-3 py-1 rounded-element text-[12px] font-medium bg-brand/10 text-brand hover:bg-brand/20 transition-colors"
          >
            Send again
          </button>
        )}
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 mb-3 text-[12px]">
        {byteCount > 0 && (
          <>
            <span className="text-text-muted">Length</span>
            <span className="font-mono text-text-secondary">{byteCount} B</span>
          </>
        )}
        {measurements(frame).map(([label, value]) => (
          <Fragment key={label}>
            <span className="text-text-muted">{label}</span>
            <span className="font-mono text-text-secondary">{value}</span>
          </Fragment>
        ))}
      </div>

      {frame.decodeError && (
        <div className="text-rssi-bad text-xs mb-3">
          Error: {frame.decodeError}
        </div>
      )}

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
