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
  pulse?: boolean;
};

function StatusBadge({ label, tone, pulse = false }: StatusBadgeProps) {
  const classes = ['status-badge', `status-badge-${tone}`, pulse ? 'status-badge-pulse' : ''].filter(Boolean).join(' ');
  return <span className={classes}>{label}</span>;
}

export default StatusBadge;