/** Framework-free labels shared by Hub Worktree views. */
/** Strips the Git ref prefix and optionally uses the browser’s localized detached label. */
export function branchLabel(row: { branch: string | null; detached: boolean | null; head: string | null }, localized = false): string {
  if (row.detached && localized) return ['Detached', row.head?.slice(0, 12)].filter(Boolean).join(' ');
  if (row.detached) return `detached ${row.head?.slice(0, 12) ?? 'Unknown'}`;
  return row.branch ? row.branch.replace(/^refs\/heads\//, '') : 'Unknown';
}

/** Formats binary multiples using terminal defaults or a localized formatter with IEC labels. */
export function formatBytes(bytes: number, format?: (value: number) => string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (format) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const unit = bytes > 0 ? Math.max(0, Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10))) : 0;
    return format(bytes / 1024 ** unit) + ' ' + units[unit];
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let unit = 0, value = bytes / 1024;
  const round = (number: number) => number < 10 ? Math.round(number * 10) / 10 : Math.round(number);
  while (unit < units.length - 1 && round(value) >= 1024) { value /= 1024; unit++; }
  const rounded = round(value);
  return `${rounded < 10 ? rounded.toFixed(1) : String(rounded)} ${units[unit]}`;
}
