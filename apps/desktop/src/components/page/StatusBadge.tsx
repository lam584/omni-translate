export type StatusTone =
  | 'complete'
  | 'pending'
  | 'risk'
  | 'draft'
  | 'ready'
  | 'warning'
  | 'stable'
  | 'experimental'
  | 'unsupported'
  | 'unknown';

type StatusBadgeProps = {
  label: string;
  tone: StatusTone;
};

function StatusBadge({ label, tone }: StatusBadgeProps) {
  return <span className={`status-badge status-badge-${tone}`}>{label}</span>;
}

export default StatusBadge;