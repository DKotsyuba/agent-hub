/** Source inventories shared by the existing shell and its visible content area. */
import { useEffect, useState } from 'react';
import { connections } from './native';
import { useInventory } from './hooks';
import { object, runPage, worktreePage, repositoryLabels } from './protocol';
import type { Inventory } from './hooks';
import type { LiveWorktree, RunAgent } from './protocol';

/** The shell consumes real identities/counts without importing fixture view models. */
export interface LiveIndex {
  /** Explicitly loaded Run inventory coverage. */
  run: Inventory<RunAgent>;
  /** Cheap, paged Worktree inventory with no inspection or requested size. */
  worktrees: Inventory<LiveWorktree>;
  /** Credential-safe native configuration diagnostics, or null while unavailable/loading. */
  connections: Record<string, unknown> | null;
  /** Canonical confirmed repository identities with one known working directory for reads. */
  repositories: { id: string; path: string; label: string }[];
}
/** Subscribes only to inventories needed by the visible section; hidden documents close native watches. */
export function useLiveIndex(section: string, refresh: number, enabled: boolean, selected: { kind: string } | null = null, tab = ''): LiveIndex {
  const run = useInventory({ resource: 'run.agents', params: { limit: 200, offset: 0 } }, runPage, offset => ({ offset }), agent => 'run:' + agent.id, refresh, enabled && (section === 'overview' || section === 'agents' || (section === 'projects' && selected !== null) || (section === 'pools' && selected !== null && (tab === 'members' || tab === ''))));
  const worktrees = useInventory({ resource: 'worktree.list', params: { limit: 20, size: false, discovery: true } }, worktreePage, cursor => ({ cursor }), tree => tree.key, refresh, enabled && (['overview', 'worktrees', 'projects'].includes(section) || (section === 'agents' && (selected === null || tab === 'details'))));
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void connections().then(value => { if (!current) return; try { const row = object(value); if (row.schema_version !== 1 || !['configured', 'invalid'].includes(String(row.state))) throw new Error('connections_schema'); setDiagnostics(row); } catch { setDiagnostics({ schema_version: 1, state: 'invalid', error: { code: 'connections_schema' } }); } });
    return () => { current = false; };
  }, [enabled, refresh]);
  const repositories = [...new Map((worktrees.page?.items ?? []).map(tree => [tree.common, { id: tree.common, path: tree.path }])).values()];
  const labels = repositoryLabels(repositories.map(repository => repository.id));
  return { run, worktrees, connections: diagnostics, repositories: repositories.map(repository => ({ ...repository, label: labels.get(repository.id)! })) };
}
