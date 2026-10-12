import type { Profile } from '../types/recording';

interface ProfileCardProps {
  profile: Profile | null;
  canModify: boolean;
  onEdit: () => void;
}

export function formatSyncWord(v: number): string {
  return `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
}

const ROWS: Array<[string, (p: Profile) => string | null]> = [
  ['Region', (p) => p.region ?? null],
  ['Frequency', (p) => (p.freq_hz != null ? `${(p.freq_hz / 1e6).toFixed(3)} MHz` : null)],
  ['Spreading factor', (p) => (p.sf != null ? `SF${p.sf}` : null)],
  ['Bandwidth', (p) => (p.bw_hz != null ? `${p.bw_hz / 1000} kHz` : null)],
  ['Coding rate', (p) => (p.cr != null ? `4/${p.cr}` : null)],
  ['Power', (p) => (p.power_dbm != null ? `${p.power_dbm} dBm` : null)],
  ['Preamble', (p) => (p.preamble != null ? `${p.preamble} symbols` : null)],
  ['Sync word', (p) => (p.sync_word != null ? formatSyncWord(p.sync_word) : null)],
  ['CRC', (p) => (p.crc_on != null ? (p.crc_on ? 'On' : 'Off') : null)],
  ['IQ', (p) => (p.iq_inverted != null ? (p.iq_inverted ? 'Inverted' : 'Standard') : null)],
  ['RX gain', (p) => (p.rx_gain === 'boosted' ? 'Boosted' : p.rx_gain === 'saving' ? 'Power saving' : null)],
];

export function ProfileCard({ profile, canModify, onEdit }: ProfileCardProps) {
  if (!profile) {
    return (
      <div className="bg-surface rounded-card p-4 text-center text-text-muted border border-border text-[13px]">
        No radio profile
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-card shadow-subtle p-4 border border-border">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[13px] font-medium text-text-secondary uppercase tracking-wider truncate">
          {profile.name ?? 'Radio profile'}
        </h2>
        {canModify && (
          <button
            onClick={onEdit}
            className="text-[13px] text-brand hover:text-brand-hover transition-colors"
          >
            Edit
          </button>
        )}
      </div>

      <div className="divide-y divide-border/50">
        {ROWS.map(([label, show]) => {
          const value = show(profile);
          if (value == null) return null;
          return (
            <div key={label} className="flex justify-between items-center py-1.5">
              <span className="text-[13px] text-text-secondary">{label}</span>
              <span className="font-mono text-[13px] text-text-primary">{value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
