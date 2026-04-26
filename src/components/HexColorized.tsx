import { useMemo } from 'react';
import type { Field } from '../types/parser';

const COLOR_MAP: Record<string, { base: string; highlight: string }> = {
  blue: { base: 'bg-[rgba(71,171,255,0.2)] text-brand', highlight: 'bg-[rgba(71,171,255,0.4)] text-brand ring-1 ring-brand/40' },
  green: { base: 'bg-[rgba(74,222,128,0.2)] text-rssi-good', highlight: 'bg-[rgba(74,222,128,0.4)] text-rssi-good ring-1 ring-rssi-good/40' },
  yellow: { base: 'bg-[rgba(251,191,36,0.2)] text-rssi-medium', highlight: 'bg-[rgba(251,191,36,0.4)] text-rssi-medium ring-1 ring-rssi-medium/40' },
  red: { base: 'bg-[rgba(248,113,113,0.15)] text-[#FCA5A5]', highlight: 'bg-[rgba(248,113,113,0.35)] text-[#FCA5A5] ring-1 ring-[#FCA5A5]/40' },
  purple: { base: 'bg-[rgba(168,85,247,0.2)] text-[#C084FC]', highlight: 'bg-[rgba(168,85,247,0.4)] text-[#C084FC] ring-1 ring-[#C084FC]/40' },
  gray: { base: 'bg-overlay text-text-secondary', highlight: 'bg-overlay text-text-primary ring-1 ring-text-muted/40' },
};

const LEGEND_DOT_COLORS: Record<string, string> = {
  blue: 'bg-[rgba(71,171,255,0.5)]',
  green: 'bg-[rgba(74,222,128,0.5)]',
  yellow: 'bg-[rgba(251,191,36,0.5)]',
  red: 'bg-[rgba(248,113,113,0.4)]',
  purple: 'bg-[rgba(168,85,247,0.5)]',
  gray: 'bg-text-muted/40',
};

interface HexColorizedProps {
  hex: string;
  fields?: Field[];
  highlightedField?: string | null;
  onHighlightField?: (fieldName: string | null) => void;
  showLegend?: boolean;
}

export function HexColorized({ hex, fields, highlightedField, onHighlightField, showLegend }: HexColorizedProps) {
  const bytes = useMemo(() => hex.match(/.{1,2}/g) || [], [hex]);

  // Map byte index -> { color, fieldName }
  const byteInfo = useMemo(() => {
    const info: { color: string | null; fieldName: string | null }[] = new Array(bytes.length).fill(null).map(() => ({ color: null, fieldName: null }));
    if (fields) {
      for (const field of fields) {
        const [start, end] = field.bytes;
        const color = field.color || 'gray';
        for (let i = start; i < end && i < bytes.length; i++) {
          info[i] = { color, fieldName: field.name };
        }
      }
    }
    return info;
  }, [fields, bytes.length]);

  // Group consecutive bytes with same color + fieldName
  const groups = useMemo(() => {
    const result: { bytes: string[]; color: string | null; fieldName: string | null }[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const { color, fieldName } = byteInfo[i];
      const last = result[result.length - 1];
      if (last && last.color === color && last.fieldName === fieldName) {
        last.bytes.push(bytes[i]);
      } else {
        result.push({ bytes: [bytes[i]], color, fieldName });
      }
    }
    return result;
  }, [bytes, byteInfo]);

  // Legend items (unique fields in order)
  const legendItems = useMemo(() => {
    if (!fields || !showLegend) return [];
    const seen = new Set<string>();
    const items: { name: string; color: string }[] = [];
    for (const field of fields) {
      if (!seen.has(field.name)) {
        seen.add(field.name);
        items.push({ name: field.name, color: field.color || 'gray' });
      }
    }
    return items;
  }, [fields, showLegend]);

  const handleGroupClick = (fieldName: string | null) => {
    if (!onHighlightField || !fieldName) return;
    onHighlightField(highlightedField === fieldName ? null : fieldName);
  };

  return (
    <div>
      <span className="font-mono text-[13px] leading-[1.8] inline-flex flex-wrap gap-0.5">
        {groups.map((group, idx) => {
          const isHighlighted = highlightedField != null && group.fieldName === highlightedField;
          const colorEntry = group.color ? COLOR_MAP[group.color] : null;
          const className = colorEntry
            ? (isHighlighted ? colorEntry.highlight : colorEntry.base)
            : '';

          return (
            <span
              key={idx}
              className={`rounded px-0.5 cursor-pointer transition-all duration-200 hover:scale-105 ${className}`}
              onClick={() => handleGroupClick(group.fieldName)}
              title={group.fieldName || undefined}
            >
              {group.bytes.join(' ')}
            </span>
          );
        })}
      </span>

      {showLegend && legendItems.length > 0 && (
        <div className="flex flex-wrap gap-3 mt-2 text-[11px]">
          {legendItems.map(item => (
            <div
              key={item.name}
              className={`flex items-center gap-1 cursor-pointer transition-opacity duration-200 ${
                highlightedField != null && highlightedField !== item.name ? 'opacity-40' : ''
              }`}
              onClick={() => handleGroupClick(item.name)}
            >
              <div className={`w-2 h-2 rounded-sm ${LEGEND_DOT_COLORS[item.color] || LEGEND_DOT_COLORS.gray}`} />
              <span className="text-text-muted">{item.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
