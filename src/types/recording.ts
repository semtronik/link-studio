// Link-LR recording format, link/protocol/v1/recording.md. The same lines
// arrive live from the device and from get_session.

export interface Profile {
  name?: string;
  region?: 'EU868' | 'US915';
  freq_hz?: number;
  sf?: number;
  bw_hz?: number;
  cr?: number;
  power_dbm?: number;
  preamble?: number;
  crc_on?: boolean;
  iq_inverted?: boolean;
  sync_word?: number;
  rx_gain?: 'saving' | 'boosted';
}

export interface SessionLine {
  type: 'session';
  v: number;
  id: number;
  part: number;
  ts?: number;
  open: string;
  boot?: string;
  fw?: string;
  dev?: string;
  profile: Profile;
}

export interface EndLine {
  type: 'end';
  ts?: number;
  reason: string;
}

export interface RxLine {
  type: 'rx';
  ts?: number;
  status: 'ok' | 'crc_err' | 'header_err' | 'incomplete';
  len?: number;
  data?: string;
  rssi_dbm?: number;
  signal_dbm?: number;
  snr_db?: number;
  freq_err_hz?: number;
  toa_ms?: number;
  cr?: number;
  crc_on?: boolean;
  noise_dbm?: number;
  inst_n?: number;
  inst_min_dbm?: number;
  inst_max_dbm?: number;
}

export interface TxLine {
  type: 'tx';
  ts?: number;
  len: number;
  data: string;
  toa_ms?: number;
  result: 'ok' | 'timeout' | 'aborted';
}

export interface GapLine {
  type: 'gap';
  from?: number;
  to?: number;
  reason: string;
}

export interface LostLine {
  type: 'lost';
  ts?: number;
  count: number;
}

export type RecordLine = SessionLine | EndLine | RxLine | TxLine | GapLine | LostLine;

export interface SessionInfo {
  type: 'session_info';
  id: number;
  ts?: number;
  end_ts?: number;
  reason?: string;
  current: boolean;
  truncated: boolean;
  bytes: number;
}
