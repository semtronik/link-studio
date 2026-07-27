/**
 * Time on Air LoRa — formule Semtech (AN1200.13).
 *
 * Parametres non transmis par la trame : le firmware LFT fige CR=4/8 et
 * un preambule de 15 symboles (cf. build_rfcfg_cmd dans translator.c).
 * Le resultat est donc exact pour du trafic emis par un LFT, et
 * approximatif pour un equipement tiers configure autrement.
 */

const CODING_RATE = 4; // CR 4/8 → cr = 4
const PREAMBLE_SYMBOLS = 15;
const EXPLICIT_HEADER = true;
const CRC_ENABLED = true;

/** Duree d'emission en millisecondes. bw en kHz, payload en octets. */
export function computeToaMs(payloadBytes: number, sf: number, bwKhz: number): number {
  if (!sf || !bwKhz) return 0;

  const bwHz = bwKhz * 1000;
  const symbolMs = ((1 << sf) / bwHz) * 1000;

  /* Low Data Rate Optimization : impose des que la duree symbole depasse
   * 16 ms, ce qui arrive en SF11/SF12 a 125 kHz. */
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
