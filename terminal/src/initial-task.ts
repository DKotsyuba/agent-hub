/** Collects and verifies Agent Run's exact `initial_task` v1 pages before any task text is shown. */
import { integer, object, sha256 } from '../../src/live/protocol.ts';
import type { ReadResponse } from './api.ts';

/** Largest task and page the contract can ever permit; an advertisement may only lower them. */
const TASK_LIMIT = 524_288;
const PAGE_LIMIT = 65_536;
/** A page budget of 64 KiB bounds a task to nine pages; more means a misbehaving source. */
const MAX_PAGES = 16;
const encoder = new TextEncoder();

export type InitialTaskMode = 'strict' | 'current';

/** The advertised `capabilities.initial_task` entry, validated against the v1 contract. */
export interface InitialTaskCapability { modes: InitialTaskMode[]; maxTaskBytes: number; maxPageBytes: number }

/** What the caller already knows; strict needs the full proven fence, current needs only the ID. */
export interface InitialTaskRequest {
  mode: InitialTaskMode;
  agentId: string;
  storeId?: string;
  executionRef?: string;
  pinId?: string;
}

/** The only outcomes: complete text whose length and SHA-256 were checked, or a reason it is unproven. */
export type InitialTaskResult =
  | { state: 'verified'; mode: InitialTaskMode; text: string; sha256: string; totalBytes: number; pages: number; storeId: string; agentId: string; executionRef: string; pinId: string | null }
  | { state: 'unverified'; reason: string };

/** Closed `unavailable` reasons of the contract; `strict` only ones are refused in `current` mode. */
const UNAVAILABLE = ['not_found', 'retention_deleted', 'not_root_execution', 'execution_ref_unavailable', 'execution_ref_mismatch', 'pin_missing', 'pin_released', 'pin_mismatch', 'coverage_incomplete', 'task_missing', 'task_mismatch', 'task_too_large', 'provider_identity_invalid', 'content_changed'];
const STRICT_ONLY = ['retention_deleted', 'pin_missing', 'pin_released', 'pin_mismatch', 'coverage_incomplete'];
const REF = /^ex1_[0-9a-f]{64}$/, PIN = /^pin_[0-9a-f]{32}$/, STORE = /^store_[0-9a-f]{32}$/, DIGEST = /^[0-9a-f]{64}$/;

/** Reads the optional capability from `run.identity` data; absence or any deviation means unsupported. */
export function initialTaskCapability(identity: unknown): InitialTaskCapability | null {
  try {
    const capabilities = object(object(identity).capabilities), value = capabilities.initial_task;
    if (value === undefined) return null;
    const entry = object(value);
    if (entry.version !== 1 || entry.method !== 'initial_task' || !Array.isArray(entry.modes)) return null;
    const modes = entry.modes.filter((mode): mode is InitialTaskMode => mode === 'strict' || mode === 'current');
    if (!modes.length || modes.length !== entry.modes.length || new Set(modes).size !== modes.length) return null;
    const maxTaskBytes = integer(entry.max_task_bytes), maxPageBytes = integer(entry.max_page_bytes);
    if (maxTaskBytes < 1 || maxTaskBytes > TASK_LIMIT || maxPageBytes < 4 || maxPageBytes > PAGE_LIMIT) return null;
    return { modes, maxTaskBytes, maxPageBytes };
  } catch { return null; }
}

/** Builds one page request; optional fields are omitted because the producer refuses explicit nulls. */
function pageParams(request: InitialTaskRequest, capability: InitialTaskCapability, offset: number, fence: { sha256: string; total: number; ref: string } | null): Record<string, unknown> {
  const strict = request.mode === 'strict', ref = request.executionRef ?? fence?.ref;
  return {
    version: 1, mode: request.mode, agent_id: request.agentId,
    ...(request.storeId ? { expected_store_id: request.storeId } : {}),
    ...(strict ? { sequence: 1, pin_id: request.pinId } : {}),
    ...(ref ? { execution_ref: ref } : {}),
    offset, max_bytes: capability.maxPageBytes,
    ...(fence ? { expected_sha256: fence.sha256, expected_total_bytes: fence.total } : {}),
  };
}

/** Collapses a source failure to a short reason without reflecting producer text. */
function failureReason(envelope: ReadResponse): string {
  if (envelope.error) return envelope.error.code;
  return `source_${envelope.outcome}`;
}

/** Rejects unknown keys so that a producer revision cannot smuggle unreviewed fields into the display. */
function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) throw new Error('initial_task_fields');
}

/**
 * Reads every page of one root task and returns text only after the buffered byte length and SHA-256
 * match the first page's whole-text claim. Any unavailable page, fence change, malformed field, error or
 * obsolete caller discards the buffer: earlier pages are partial historical data and are never displayed.
 */
export async function readInitialTask(read: (params: Record<string, unknown>) => Promise<ReadResponse>, request: InitialTaskRequest, capability: InitialTaskCapability, current: () => boolean = () => true): Promise<InitialTaskResult> {
  const unverified = (reason: string): InitialTaskResult => ({ state: 'unverified', reason });
  const strict = request.mode === 'strict';
  if (!capability.modes.includes(request.mode)) return unverified('mode_unsupported');
  if (!request.agentId || request.storeId !== undefined && !STORE.test(request.storeId) || request.executionRef !== undefined && !REF.test(request.executionRef)) return unverified('request_invalid');
  if (strict && (!request.storeId || !request.executionRef || !request.pinId || !PIN.test(request.pinId)) || !strict && request.pinId !== undefined) return unverified('request_invalid');
  const pages: string[] = [];
  let buffered = 0, first: { sha256: string; total: number; ref: string; store: string } | null = null;
  try {
    for (let count = 0; ; count++) {
      if (!current()) return unverified('obsolete');
      if (count >= MAX_PAGES) return unverified('page_budget');
      const envelope = await read(pageParams(request, capability, buffered, first));
      if (!current()) return unverified('obsolete');
      if (envelope.error !== null || envelope.outcome !== 'ok' && envelope.outcome !== 'partial') return unverified(failureReason(envelope));
      const page = object(envelope.data);
      if (page.version !== 1 || page.mode !== request.mode || page.agent_id !== request.agentId) return unverified('page_identity');
      if (page.state === 'unavailable') {
        exactKeys(page, ['state', 'version', 'mode', 'agent_id', 'reason', ...('store_id' in page ? ['store_id'] : [])]);
        const reason = page.reason;
        if (typeof reason !== 'string' || !UNAVAILABLE.includes(reason) || !strict && STRICT_ONLY.includes(reason)) return unverified('unavailable_reason');
        if ('store_id' in page && (typeof page.store_id !== 'string' || !STORE.test(page.store_id) || request.storeId && page.store_id !== request.storeId || first && page.store_id !== first.store)) return unverified('page_identity');
        return unverified(reason);
      }
      if (page.state !== 'available') return unverified('page_state');
      exactKeys(page, ['state', 'version', 'mode', 'store_id', 'agent_id', 'sequence', 'execution_ref', ...(strict ? ['pin_id'] : []), 'total_bytes', 'sha256', 'offset', 'end', 'next_offset', 'text', 'complete']);
      if (envelope.outcome === 'partial' && page.complete !== false) return unverified('page_invalid');
      const store = page.store_id, ref = page.execution_ref, digest = page.sha256, total = integer(page.total_bytes), offset = integer(page.offset), end = integer(page.end), text = page.text;
      if (typeof store !== 'string' || !STORE.test(store) || typeof ref !== 'string' || !REF.test(ref) || typeof digest !== 'string' || !DIGEST.test(digest) || typeof text !== 'string' || !text.isWellFormed()) return unverified('page_invalid');
      if (page.sequence !== 1 || strict && page.pin_id !== request.pinId) return unverified('page_identity');
      if (request.storeId && store !== request.storeId || request.executionRef && ref !== request.executionRef) return unverified('page_identity');
      if (first ? store !== first.store || ref !== first.ref || digest !== first.sha256 || total !== first.total : false) return unverified('page_identity');
      if (total < 1 || total > capability.maxTaskBytes) return unverified('page_total');
      const bytes = encoder.encode(text).length;
      if (offset !== buffered || end <= offset || end > total || bytes !== end - offset || bytes > capability.maxPageBytes) return unverified('page_range');
      const complete = end === total;
      if (page.complete !== complete || page.next_offset !== (complete ? null : end)) return unverified('page_range');
      first ??= { sha256: digest, total, ref, store };
      pages.push(text); buffered = end;
      if (complete) {
        const joined = pages.join('');
        if (encoder.encode(joined).length !== total || joined.includes('\0') || !joined.trim()) return unverified('task_invalid');
        if (await sha256(joined) !== digest) return unverified('digest_mismatch');
        if (!current()) return unverified('obsolete');
        return { state: 'verified', mode: request.mode, text: joined, sha256: digest, totalBytes: total, pages: pages.length, storeId: store, agentId: request.agentId, executionRef: ref, pinId: strict ? request.pinId! : null };
      }
    }
  } catch { return unverified('page_invalid'); }
}

/** Short bottom-row label; unverified text keeps the established wording and appends only a static reason. */
export function initialTaskLabel(result: InitialTaskResult | null | 'reading'): string {
  if (result === 'reading') return 'Initial task unverified · showing retained history · verifying exact task…';
  if (!result) return 'Initial task unverified · showing retained history';
  if (result.state === 'unverified') return `Initial task unverified · showing retained history · ${result.reason}`;
  return `Initial task verified (${result.mode}) · SHA-256 ${result.sha256.slice(0, 12)}… · ${result.totalBytes} bytes · see Details [d]`;
}

/** Details-tab lines for a verified task; the scope of the claim is stated beside it. */
export function initialTaskScope(result: Extract<InitialTaskResult, { state: 'verified' }>): string {
  return result.mode === 'strict'
    ? `Initial task · SHA-256 verified · strict: store ${result.storeId}, ref and active pin matched, lineage coverage complete`
    : 'Initial task · SHA-256 verified · current retained root only: no pin, coverage or older Pool-binding claim';
}
