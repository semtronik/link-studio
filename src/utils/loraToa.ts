// LoRa time on air, Semtech AN1200.13. Assumes CR 4/8, preamble 15, explicit header, CRC on.

const CODING_RATE = 4; // CR 4/8 → cr = 4
const PREAMBLE_SYMBOLS = 15;
const EXPLICIT_HEADER = true;
const CRC_ENABLED = true;

/** Airtime in ms; bw in kHz, payload in bytes. */
export function computeToaMs(payloadBytes: number, sf: number, bwKhz: number): number {
  if (!sf || !bwKhz) return 0;

  const bwHz = bwKhz * 1000;
  const symbolMs = ((1 << sf) / bwHz) * 1000;

  // LDRO is mandatory above 16 ms per symbol (SF11/SF12 at 125 kHz).
  const lowDataRateOptimize = symbolMs > 16 ? 1 : 0;

  const numerator =
    8 * payloadBytes -
    4 * sf +
    28 +
    (CRC_ENABLED ? 16 : 0) -
    (EXPLICIT_HEADER ? 0 : 20);
  const denominator = 4 * (sf - 2 * lowDataRateOptimize);

  const payloadSymbols =
    8 + Math.max(Math.ceil(numerator / denominator) * (CODING_RATE + 4), 0);

  const preambleMs = (PREAMBLE_SYMBOLS + 4.25) * symbolMs;
  return preambleMs + payloadSymbols * symbolMs;
}
