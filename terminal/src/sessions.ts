/** Source-preserving projections shared by the session picker and detail header. */
import type { RunAgent } from '../../src/live/protocol.ts';

/** Uses a reported workdir first; task-text paths remain explicitly inferred. */
export function agentWorkdir(agent: RunAgent): { path: string; inferred: boolean } | null {
  if (agent.workdir) return { path: agent.workdir, inferred: false };
  const summary = agent.summary ?? '', marker = /workdir:/i.exec(summary);
  if (!marker) return null;
  const token = summary.slice(marker.index + marker[0].length).split(/\s+/).find(value => value.startsWith('/') || value.startsWith('~'));
  const path = token?.replace(/^[.,;:)’"'`]+|[.,;:)’"'`]+$/g, '');
  return path ? { path, inferred: true } : null;
}

/** Groups the same conventional worktree paths as Agent Run without asserting repository identity. */
export function projectRoot(workdir: string): string {
  const parts = workdir.split('/'), index = parts.findIndex(value => value === 'worktrees' || value === '.worktrees');
  if (index < 0) return workdir;
  const end = index > 0 && parts[index - 1].startsWith('.') ? index - 1 : index;
  return parts.slice(0, end).join('/') || (workdir.startsWith('/') ? '/' : workdir);
}

/** Formats native usage without converting missing measurements into zero. */
export function sessionUsage(agent: RunAgent): string {
  const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const count = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
  const money = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `$${value.toFixed(2)}` : '$—';
  const usage = record(agent.raw.usage), tools = record(agent.raw.tool_counts), total = record(agent.raw.usage_cumulative), parts: string[] = [];
  if (usage) parts.push(`in ${count(usage.input_tokens)} · out ${count(usage.output_tokens)} · cache ${count(usage.cache_read_tokens)} · ${money(usage.cost_usd)} · turns ${count(usage.num_turns)}`);
  if (tools) parts.push(`tools ${count(tools.calls)} · ${count(tools.failed)} failed · ${count(tools.unknown_results)} unknown`);
  if (total && count(total.executions) !== '—') {
    const fields = ['cost_usd', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'num_turns', 'total_tokens'];
    const differs = !usage || fields.some(key => typeof total[key] === 'number' && Number.isFinite(total[key]) && total[key] !== usage[key]);
    if (differs) {
      const aggregate = money(total.cost_usd) !== '$—' ? money(total.cost_usd) : count(total.total_tokens) !== '—' ? `${count(total.total_tokens)} tokens` : count(total.input_tokens) !== '—' ? `${count(total.input_tokens)} in` : '';
      if (aggregate) parts.push(`Σ ${count(total.executions)} runs ${aggregate}`);
    }
  }
  return parts.join(' · ');
}
