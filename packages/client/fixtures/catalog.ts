/** Validates the internal scenario format at load time so JSON drift fails before serving. */
import { observation, capabilities } from '../../domain/src/common.ts';
import { bridgeIncident, overview, quota, worktreeDetail, worktrees } from '../../domain/src/observations.ts';
import { poolContent, poolDetail, poolHistory, poolRecord, poolSection, pools } from '../../domain/src/pools.ts';
import { initialTask, sessionDetail, sessionExport, sessionHistory, sessionResult } from '../../domain/src/sessions.ts';
import { type Decoded, array, count, invalid, nullable, object, optional } from '../../domain/src/schema.ts';
import populated from './populated.json' with { type: 'json' };
import empty from './empty.json' with { type: 'json' };
import partialStale from './partial-stale.json' with { type: 'json' };
import incompatible from './incompatible.json' with { type: 'json' };
import unavailable from './unavailable.json' with { type: 'json' };

/** Fixture names are explicit selections and stable test inputs. */
export const SCENARIOS = { populated, empty, 'partial-stale': partialStale, incompatible, unavailable } as const;

/** One supported fixture scenario. */
export type FixtureScenario = keyof typeof SCENARIOS;

/** Source keys are the independent observation sources retained in the catalog. */
const sourceFields = { run: observation, pool: observation, quota: observation, worktree: observation, bridge: observation };

/** Nested Pool sections use their public discriminated DTOs. */
function sections(value: unknown, path = '$') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path, 'sections object');
  return Object.entries(value).map(([section, items]) => poolSection({ section, items, revision: null }, `${path}.${section}`));
}

/** Decoders whose catalog members share the same projection schema as their HTTP route. */
const catalog = object({
  clockMs: count, observations: object(sourceFields),
  capabilities: object({
    run: optional(capabilities), pool: optional(capabilities), quota: optional(capabilities),
    worktree: optional(capabilities), bridge: optional(capabilities),
  }),
  overview: object({
    // Reuse the projection after adding the supplied bounds in catalogOverview.
    run: (value, path) => catalogOverview('run', value, path),
    bridge: (value, path) => catalogOverview('bridge', value, path),
    quota: (value, path) => catalogOverview('quota', value, path),
  }),
  sessions: array(object({
    detail: sessionDetail, history: sessionHistory, initialTask, result: nullable(sessionResult),
    exports: object({ retained: nullable(sessionExport), exact: optional(sessionExport) }),
  })),
  pools: array(object({ detail: poolDetail, history: poolHistory, sections, content: array(poolContent), records: array(poolRecord) })),
  poolTotals: (value, path) => pools({ items: [], totals: value }, path).totals,
  quota, bridgeAcceptedAtMs: array(count),
  projects: (value, path) => worktrees({ items: [], projects: value }, path).projects,
  worktrees: array(worktreeDetail), incidents: array(bridgeIncident),
});

/** Validates one overview source without requiring the period for the entire catalog. */
function catalogOverview<K extends 'run' | 'bridge' | 'quota'>(key: K, value: unknown, path?: string) {
  return overview({ from: null, to: null, run: null, bridge: null, quota: null, [key]: value }, path)[key];
}

/** Typed catalog used by the isolated fetch implementation. */
export type FixtureCatalog = Decoded<typeof catalog>;

/** Validates and returns the requested named scenario. */
export function loadCatalog(scenario: FixtureScenario): FixtureCatalog {
  if (!Object.hasOwn(SCENARIOS, scenario)) throw new Error('Unknown fixture scenario.');
  const result = catalog(SCENARIOS[scenario]);
  for (const [key, value] of Object.entries(result.observations)) {
    if (key !== value.source) throw new Error('Mismatched fixture source.');
  }
  return result;
}
