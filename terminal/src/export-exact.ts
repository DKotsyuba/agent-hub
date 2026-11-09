/** Collects the draft Run v1 pinned transcript before publishing any historical text. */
import type { ObservationClient } from './api.ts';
import { integer, number, object, response, sha256 } from '../../src/live/protocol.ts';
import { runStatusRequest } from './run-status.ts';
import type { RunStatusRequest } from './run-status.ts';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024;
const MAX_PAGES = 10_000;
const TIMEOUT_MS = 30_000;
const encoder = new TextEncoder();
const messageFields = ['seq', 'at', 'role', 'name', 'content', 'raw_ref', 'error', 'error_source', 'content_complete'];

/** One fully verified source message with its lossless sequence and metadata. */
interface ExactMessage { seq: string; role: string; content: string; raw: Record<string, unknown> }

/** Rejects unknown v1 fields, including unsupported truncation or partial-result markers. */
function fields(value: Record<string, unknown>, expected: string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) throw new Error('Invalid exact transcript v1 fields');
}

/** Preserves a canonical SQLite sequence without a floating-point conversion. */
function sequence(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 19 || /[^0-9]/.test(value) || value.length > 1 && value.startsWith('0') || BigInt(value) > 9223372036854775807n) throw new Error('Invalid exact transcript sequence');
  return value;
}

/** Reads byte coordinates within the producer's complete-message limit. */
function offset(value: unknown): number {
  const result = integer(value);
  if (result > MAX_MESSAGE_BYTES) throw new Error('Invalid exact transcript offset');
  return result;
}

/** Requires valid Unicode before UTF-8 encoding so lone surrogates cannot be replaced silently. */
function unicode(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed()) throw new Error('Invalid exact transcript UTF-8 text');
  return value;
}

/** Produces reversible source metadata without active terminal or direction-control bytes. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Escapes backslashes and controls while retaining source line breaks, tabs and Unicode. */
function readableText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Checks the digested immutable message, including every known v1 completeness field. */
function message(value: unknown, expectedSeq: string): ExactMessage {
  const row = object(value);
  if (Object.keys(row).join('\0') !== messageFields.join('\0') || sequence(row.seq) !== expectedSeq || row.content_complete !== true || number(row.at) === null || Number(row.at) < 0 || typeof row.error !== 'boolean' && row.error !== null) throw new Error('Exact transcript message is incomplete or invalid');
  const content = unicode(row.content), role = unicode(row.role);
  if (encoder.encode(content).length > MAX_MESSAGE_BYTES) throw new Error('Exact transcript content exceeds message limit');
  for (const field of ['role', 'name', 'raw_ref', 'error_source']) {
    if (field !== 'role' && row[field] === null) continue;
    if (encoder.encode(unicode(row[field])).length > 4096) throw new Error('Exact transcript metadata exceeds limit');
  }
  return { seq: expectedSeq, role, content, raw: row };
}

/** Returns a complete historical snapshot only after every exact identity, byte and digest check.
 * The draft source method alone proves active pin/coverage per read; no fallback, lifecycle or authority is inferred.
 */
export async function exportExactHistory(client: ObservationClient, request: RunStatusRequest, signal?: AbortSignal): Promise<string> {
  const input = object(request);
  if (input.version !== 1 || !Array.isArray(input.targets) || input.targets.length !== 1) throw new Error('Exact transcript requires one complete selector');
  const target = object(input.targets[0]);
  const checked = runStatusRequest({ run_id: target.agent_id, run_sequence: target.sequence, run_execution_ref: target.execution_ref, run_pin_id: target.pin_id, run_store_id: input.expected_store_id });
  const selector = checked.targets[0], storeId = checked.expected_store_id;
  if (!storeId || !selector.execution_ref || !selector.pin_id) throw new Error('Exact transcript requires store, incarnation and active pin');
  const controller = new AbortController(), deadline = performance.now() + TIMEOUT_MS;
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, TIMEOUT_MS);
  /** Enforces the deadline also after synchronous decoding or formatting work. */
  function active(): void {
    if (controller.signal.aborted || performance.now() >= deadline) throw new Error('Exact transcript export cancelled or timed out');
  }
  let cursor = '0', upper: string | undefined, start = 0, pages = 0, sourceBytes = 0;
  let pending: { seq: string; hash: string; total: number; text: string[] } | null = null;
  const blocks: ExactMessage[] = [];
  try {
    for (;;) {
      active();
      if (++pages > MAX_PAGES) throw new Error('Exact transcript exceeds export page limit');
      const params = { version: 1, expected_store_id: storeId, selector, cursor, offset: start, ...(upper === undefined ? {} : { upper_seq: upper }), ...(pending ? { expected_sha256: pending.hash } : {}) };
      let onAbort: (() => void) | undefined;
      let value: unknown;
      try {
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('Exact transcript export cancelled or timed out'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const envelope = response(await Promise.race([client.read('run.transcript_exact', params, controller.signal), aborted]), 'run.transcript_exact');
        active();
        if (envelope.outcome !== 'ok' || envelope.error !== null) throw new Error('Exact transcript source unavailable or incomplete');
        value = envelope.data;
      } finally { if (onAbort) controller.signal.removeEventListener('abort', onAbort); }
      const page = object(value), echo = object(page.selector), watermark = sequence(page.upper_seq), next = sequence(page.next_cursor), nextOffset = offset(page.next_offset);
      fields(page, ['version', 'store_id', 'selector', 'cursor', 'upper_seq', 'offset', 'message', 'next_cursor', 'next_offset', 'snapshot_complete']);
      fields(echo, ['agent_id', 'sequence', 'execution_ref', 'pin_id']);
      if (page.version !== 1 || page.store_id !== storeId || echo.agent_id !== selector.agent_id || echo.sequence !== selector.sequence || echo.execution_ref !== selector.execution_ref || echo.pin_id !== selector.pin_id || sequence(page.cursor) !== cursor || offset(page.offset) !== start || upper !== undefined && upper !== watermark || BigInt(cursor) > BigInt(watermark) || typeof page.snapshot_complete !== 'boolean') throw new Error('Exact transcript identity or watermark changed');
      upper = watermark;
      if (page.message === null) {
        if (pending || cursor !== upper || start !== 0 || next !== cursor || nextOffset !== 0 || page.snapshot_complete !== true) throw new Error('Exact transcript ended before the snapshot was collected');
        break;
      }
      const chunk = object(page.message), seq = sequence(chunk.seq), text = unicode(chunk.text), total = offset(chunk.total_bytes), end = offset(chunk.end), bytes = encoder.encode(text).length;
      fields(chunk, ['seq', 'sha256', 'total_bytes', 'start', 'end', 'text', 'complete']);
      if (typeof chunk.sha256 !== 'string' || chunk.sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(chunk.sha256) || BigInt(seq) <= BigInt(cursor) || BigInt(seq) > BigInt(upper) || offset(chunk.start) !== start || total === 0 || end <= start || end > total || bytes !== end - start || bytes > MAX_CHUNK_BYTES || typeof chunk.complete !== 'boolean' || chunk.complete !== (end === total) || next !== (chunk.complete ? seq : cursor) || nextOffset !== (chunk.complete ? 0 : end) || page.snapshot_complete !== (chunk.complete && seq === upper)) throw new Error('Exact transcript fragment is invalid or missing');
      if (pending && (pending.seq !== seq || pending.hash !== chunk.sha256 || pending.total !== total)) throw new Error('Exact transcript message identity changed');
      if (!pending) pending = { seq, hash: chunk.sha256, total, text: [] };
      pending.text.push(text); sourceBytes += bytes;
      if (sourceBytes > MAX_BYTES) throw new Error('Exact transcript exceeds export byte limit');
      if (chunk.complete) {
        const serialized = pending.text.join('');
        if (encoder.encode(serialized).length !== pending.total || await sha256(serialized) !== pending.hash) throw new Error('Exact transcript message digest mismatch');
        active();
        blocks.push(message(JSON.parse(serialized), seq));
        pending = null;
      }
      cursor = next; start = nextOffset;
      if (page.snapshot_complete) break;
    }
    const output: string[] = []; let outputBytes = 0;
    /** Accumulates the final readable representation without publishing any partial output. */
    function append(text: string): void {
      active(); outputBytes += encoder.encode(text).length;
      if (outputBytes > MAX_BYTES) throw new Error('Exact transcript exceeds export byte limit');
      output.push(text);
    }
    append(`agent-run exact transcript ${safeJson(selector)}\nStore: ${storeId}\nHistorical snapshot through #${upper}; no execution completion, success or authority is asserted.\nEach content line starts with | ; backslashes and controls are escaped, and tabs are retained.\n\n`);
    for (const block of blocks) {
      const { content: _content, ...metadata } = block.raw;
      const label = block.role === 'tool_call' ? 'Tool call' : block.role === 'tool_result' ? 'Tool result' : 'Message';
      const content = readableText(block.content).split('\n').map(line => `| ${line}`).join('\n');
      append(`${label} #${block.seq}\n${safeJson(metadata)}\n${content}\n\n`);
    }
    active();
    return output.join('');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort();
  }
}
