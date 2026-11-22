/** Compatibility projections for existing terminal rendering and navigation. */
import type { ApiResponse, Pool, PoolMember, Session, Worktree } from '../../packages/domain/src/index.ts';

type History = ApiResponse<'sessionHistory'>['data'];
type Message = ApiResponse<'poolHistory'>['data']['items'][number];

/** Convert an optional DTO clock into the seconds used by terminal labels. */
export function seconds(value: number | null | undefined): number | null {
  return value == null ? null : value / 1000;
}

/** Local wrappers preserve the rendering seam without exposing legacy routes. */
export function productPage(kind: string, data: unknown) {
  return { schema_version: 1, kind, data, error: null };
}

/** Keep the opaque execution selector alongside the legacy display fields. */
export function sessionRow(row: Session) {
  return {
    agent_id: row.id, sequence: row.sequence ?? 0, execution: row.execution, status: row.status,
    name: row.name, task_summary: row.summary, workdir: row.workdir, project_id: row.projectId, project_inferred: row.projectInferred,
    model: row.model, effort: row.effort, runtime: row.runtime, elapsed_seconds: seconds(row.elapsedMs), silence_seconds: seconds(row.silenceMs),
    created_at: seconds(row.createdAtMs), observed_at: seconds(row.observedAtMs), finished_at: seconds(row.finishedAtMs),
    last_progress_at: seconds(row.progressAtMs), last_action: row.lastAction, answer_available: row.answerAvailable,
    failure_kind: row.failureKind, failure_text: row.failureText,
  };
}

/** Preserve the server's grouping and source IDs in the terminal history blocks. */
export function sessionBlocks(entries: History['entries']) {
  return entries.flatMap(({ head, calls, results, partialBefore, partialAfter }) =>
    [...new Map([head, ...calls, ...results].map(fragment => [fragment.id, fragment])).values()].map(fragment => {
      const sequence = Number(fragment.position);
      return {
        seq: Number.isSafeInteger(sequence) ? sequence : 0, source_position: fragment.position, fragment_id: fragment.id, group_id: head.id, role: fragment.role,
        source_role: fragment.sourceRole, content: fragment.text, partial_before: partialBefore, partial_after: partialAfter,
        name: fragment.name, raw_ref: fragment.sourceRef, at: seconds(fragment.atMs), error: fragment.error,
        first_position: fragment.firstPosition,
        end_at: fragment.endAtMs === undefined ? undefined : seconds(fragment.endAtMs), content_complete: fragment.complete, omitted_bytes: fragment.omittedBytes,
      };
    }));
}

/** Translate display facts while retaining the distinction between closure and a record. */
export function poolRow(row: Pool) {
  return {
    pool_id: row.id, name: row.name ?? row.id, purpose: row.purposePreview ?? '', closed: row.state === 'closed',
    closure_state: row.state, revision_exact: row.revision, revision: Number(row.revision ?? '0'),
    ...(row.kind === null ? {} : { kind: row.kind }),
    ...(row.record === undefined ? {} : { completion_id: row.record?.id ?? null }),
  };
}

/** Keep seat admission, joining and Run link evidence independent. */
export function memberRow(member: PoolMember) {
  return {
    member_id: member.id, name: member.name ?? member.id, role: member.role ?? 'Unknown', task: member.task ?? '',
    state: member.state ?? 'Unknown', runtime: member.runtime, hub_session: member.session, hub_lineage: member.lineage,
    ...(member.seat && {
      seat_id: member.seat.id, profile: member.seat.profile, admission: member.seat.admission, joined: member.seat.joined,
      run_agent_id: member.session?.sessionId ?? null,
    }),
  };
}

/** Adapt one already-grouped message without reinterpreting its validity or positions. */
export function journalRow(item: Message) {
  return {
    event_id: item.position, event_id_exact: item.position, kind: item.kind,
    author: { kind: item.authorKind, member_id: item.authorId }, recipient: item.recipientId,
    revision: item.revision, body: item.parts.join(''), at_ms: item.atMs,
    projected_complete: item.complete, projected_valid: item.valid, projected_range: item.partRange,
  };
}

/** Retain stable IDs even when a Worktree pathname is absent. */
export function treeRow(row: Worktree) {
  return {
    key: row.id, class: row.class, path: row.path, branch: row.branch, detached: row.detached, head: row.head,
    repo_id: row.projectId, sessions: row.sessions, activity: { state: row.activity, mtime_based: row.mtimeBased },
    integration: row.integration, removal_started: row.removalStarted, creator: row.creator,
  };
}

/** Transfer cached measured axes as independent probe results. */
export function treeDetail(data: ApiResponse<'worktree'>['data']) {
  const { worktree, activitySignals: clocks } = data;
  const { status, size } = worktree.facts;
  const fields = (items: { key: string; value: string | null }[] | null | undefined) =>
    items ? Object.fromEntries(items.map(item => [item.key, item.value])) : null;
  return {
    ...treeRow(worktree), activity: worktree.activity, repo_common_dir: data.repositoryPath,
    activity_signals: clocks && { head_mtime: seconds(clocks.headMtimeMs), index_mtime: seconds(clocks.indexMtimeMs), last_reflog_entry: seconds(clocks.reflogAtMs) },
    observed_at: seconds(data.inspectedAtMs ?? worktree.facts.observedAtMs), warnings: data.warnings, hygiene: fields(data.hygiene), record: fields(data.managedRecord),
    probes: {
      ...Object.fromEntries(data.probes.map(probe => [probe.name, { ...probe, reason: probe.detail }])),
      status: status.state === 'known' ? { state: status.lowerBound ? 'incomplete' : 'known', value: status.value } : status,
      size: size.state === 'known' ? { state: size.lowerBound ? 'incomplete' : 'known', value: { bytes: size.value } } : size,
    },
  };
}
