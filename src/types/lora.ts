export interface LoRaConfig {
  freq: number;
  sf: number;
  bw: number;
  drops: number;
}

export interface Frame {
  id: string;
  type: 'frame';
  hex: string;
  timestamp: number;
  rssi?: number;
  snr?: number;
}

export interface LicenseClaims {
  exp: number;
  machine_id: string;
  features: string[];
}
