import type { Frame } from '../types/journal';
import type { Profile, RecordLine, SessionLine } from '../types/recording';

/** Lowest SNR the SX1262 demodulates, SF5 to SF12 (link_radio.c). */
export function snrLimitDb(sf: number): number {
  return sf >= 5 && sf <= 12 ? -2.5 * (sf - 4) : -7.5;
}

/* Margin classes of the device (link_radio.h), in dB. */
export const MARGIN_GOOD_DB = 10;
export const MARGIN_FAIR_DB = 3;

export type MarginClass = 'good' | 'fair' | 'poor';

export function marginClass(marginDb: number): MarginClass {
  if (marginDb >= MARGIN_GOOD_DB) return 'good';
  if (marginDb >= MARGIN_FAIR_DB) return 'fair';
  return 'poor';
}

/** Journal row for a recording line; null for `session` and `end`.
 *  `sf` is the session's, for the margin. */
export function lineToFrame(line: RecordLine, sf?: number): Frame | null {
  const id = crypto.randomUUID();
  switch (line.type) {
    case 'rx':
      return {
        id, kind: 'rx', line,
        hex: line.data ?? '',
        timestamp: (line.ts ?? 0) / 1000,
        rssi: line.rssi_dbm,
        snr: line.snr_db,
        margin: line.snr_db != null && sf != null ? line.snr_db - snrLimitDb(sf) : undefined,
        toaMs: line.toa_ms,
        status: line.status,
      };
    case 'tx':
      return {
        id, kind: 'tx', line,
        hex: line.data,
        timestamp: (line.ts ?? 0) / 1000,
        toaMs: line.toa_ms,
        status: line.result,
      };
    case 'gap':
      return { id, kind: 'gap', line, hex: '', timestamp: (line.from ?? 0) / 1000 };
    case 'lost':
      return { id, kind: 'lost', line, hex: '', timestamp: (line.ts ?? 0) / 1000 };
    default:
      return null;
  }
}

/** Each frame takes its SF from the `session` line before it. */
export function linesToFrames(lines: RecordLine[]): Frame[] {
  const frames: Frame[] = [];
  let sf: number | undefined;
  for (const line of lines) {
    if (line.type === 'session') sf = line.profile.sf;
    const frame = lineToFrame(line, sf);
    if (frame) frames.push(frame);
  }
  return frames;
}

/** Only payloads worth decoding: a CRC error's bytes are corrupt. */
export function isDecodable(frame: Frame): boolean {
  return frame.hex !== '' && (frame.kind === 'tx' || frame.status === 'ok');
}

/** The profile a set of lines was recorded with: its last `session` line. */
export function profileOf(lines: RecordLine[]): Profile | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].type === 'session') return (lines[i] as SessionLine).profile;
  }
  return null;
}

/** A .jsonl recording: lines that are not recording lines are skipped. */
export function parseJsonl(text: string): RecordLine[] {
  const types = new Set(['session', 'end', 'rx', 'tx', 'gap', 'lost']);
  const lines: RecordLine[] = [];
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (!s.startsWith('{')) continue;
    try {
      const obj = JSON.parse(s);
      if (types.has(obj?.type)) lines.push(obj);
    } catch {
      /* not JSON */
    }
  }
  return lines;
}

export function toJsonl(lines: RecordLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function formatToa(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
