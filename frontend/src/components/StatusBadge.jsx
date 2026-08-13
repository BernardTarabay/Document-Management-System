// Central place mapping every status/confidence string used across the API
// (job_status, file_status, proposal_status, confidence_level, ...) to a
// consistent color language. Keeping this one file means "amber = medium
// confidence / pending review" reads the same everywhere in the app.
const MAP = {
  // confidence
  high: "badge-emerald",
  medium: "badge-amber",
  low: "badge-rose",
  // jobs
  queued: "badge-neutral",
  running: "badge-blue",
  completed: "badge-emerald",
  failed: "badge-rose",
  cancelled: "badge-neutral",
  retrying: "badge-amber",
  // storage location access mode -- "direct" reaches the disk itself,
  // "agent" is brokered by a Filesystem Agent, so it depends on that agent
  // being connected. Blue rather than green says "working, but with a
  // dependency" without implying anything is wrong.
  direct: "badge-emerald",
  agent: "badge-blue",
  // files / documents
  active: "badge-emerald",
  missing: "badge-rose",
  moved: "badge-blue",
  changed: "badge-amber",
  deleted: "badge-neutral",
  archived: "badge-neutral",
  // email accounts (inbox)
  connected: "badge-emerald",
  disconnected: "badge-neutral",
  error: "badge-rose",
  // inbox message triage
  kept: "badge-emerald",
  junk: "badge-rose",
  important: "badge-emerald",
  // proposals / classification
  pending: "badge-amber",
  approved: "badge-emerald",
  rejected: "badge-rose",
  applied: "badge-violet",
  superseded: "badge-neutral",
  proposed: "badge-amber",
  confirmed: "badge-emerald",
  open: "badge-amber",
  resolved: "badge-emerald",
};

export function StatusBadge({ value, label }) {
  if (!value) return <span className="badge-neutral">—</span>;
  const cls = MAP[value] || "badge-neutral";
  return <span className={cls}>{label || value.replace(/_/g, " ")}</span>;
}
