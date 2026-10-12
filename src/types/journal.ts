import type { RecordLine, RxLine, TxLine } from './recording';

/** One row of the journal: a reception, a transmission, or a break in reception. */
export interface Frame {
  id: string;
  kind: 'rx' | 'tx' | 'gap' | 'lost';
  /** Payload hex; '' when there is none (header error, incomplete, gap, lost). */
  hex: string;
  /** Seconds. Start of the frame, as the device timestamps it. */
  timestamp: number;
  rssi?: number;
  snr?: number;
  /** dB above the lowest SNR the session's SF demodulates. */
  margin?: number;
  toaMs?: number;
  /** rx: reception status; tx: how the transmission ended. */
  status?: RxLine['status'] | TxLine['result'];
  line: RecordLine;
}
