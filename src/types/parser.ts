import type { Frame } from './lora';

// --- Parser contract ---

export interface DecodeContext {
  timestamp: number;
  rssi?: number;
  snr?: number;
}

export interface Field {
  name: string;
  value: any;
  unit?: string;
  bytes: [number, number]; // [start, end), 0-based byte offsets
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'gray';
}

export interface DecodeResult {
  fields: Field[];
  meta?: Record<string, any>;
  summary?: string;
}

// --- analyze() result ---

export interface Annotation {
  status: 'ok' | 'error' | 'warning' | 'linked';
  label: string;
}

export interface Metric {
  name: string;
  value: string;
}

export interface AnalyzeResult {
  annotations: Record<string, Annotation>;
  metrics: Metric[];
}

// --- App state ---

export interface ParserInfo {
  name: string;
  version?: string;
  description?: string;
  hasAnalyze: boolean;
}

export interface DecodedFrame extends Frame {
  decoded?: DecodeResult;
  decodeError?: string;
}

// --- Messages Worker ↔ App ---

export type WorkerRequest =
  | { type: 'load'; code: string }
  | { type: 'decode'; id: string; hex: string; context: DecodeContext }
  | { type: 'analyze'; frames: Array<{ id: string; hex: string; timestamp: number; decoded: DecodeResult }> };

export type WorkerResponse =
  | { type: 'loaded'; name: string; version?: string; description?: string; hasAnalyze: boolean }
  | { type: 'load-error'; error: string }
  | { type: 'decoded'; id: string; result: DecodeResult }
  | { type: 'decode-error'; id: string; error: string }
  | { type: 'analyzed'; result: AnalyzeResult }
  | { type: 'analyze-error'; error: string };
