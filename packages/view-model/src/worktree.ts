/** Framework-free labels shared by Hub Worktree views. */
/** Strips the refs/heads/ prefix for display only. */
export function branchLabel(row: { branch: string | null; detached: boolean | null; head: string | null }): string {
  if (row.detached) return `detached ${row.head?.slice(0, 12) ?? 'Unknown'}`;
  return row.branch ? row.branch.replace(/^refs\/heads\//, '') : 'Unknown';
}

/** Formats a byte count with binary multiples (1 GB = 1024³ bytes, like `du -h`): 0 B, 640 KB, 1.2 GB, 12 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let unit = 0, value = bytes / 1024;
  const round = (number: number) => number < 10 ? Math.round(number * 10) / 10 : Math.round(number);
  while (unit < units.length - 1 && round(value) >= 1024) { value /= 1024; unit++; }
  const rounded = round(value);
  return `${rounded < 10 ? rounded.toFixed(1) : String(rounded)} ${units[unit]}`;
}
