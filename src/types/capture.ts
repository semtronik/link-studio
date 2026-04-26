import type { LoRaConfig } from './lora';

export interface CaptureFile {
  config?: LoRaConfig;
  frames: Array<{
    timestamp: number;
    rssi?: number;
    snr?: number;
    hex: string;
  }>;
}
