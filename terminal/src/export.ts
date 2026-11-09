import type { ObservationClient, Resource } from './api.ts';
import { independentlyPartial } from './api.ts';
import { integer, object, product, response, transcriptPage } from '../../src/live/protocol.ts';
import type { TranscriptBlock } from '../../src/live/protocol.ts';
import { groupTranscript } from './transcript.ts';
import { groupPoolEvents, poolWindow } from './pool.ts';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 10_000;
const TIMEOUT_MS = 30_000;

/** Encodes source records as reversible JSON while escaping terminal control characters. */
function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Keeps copied text readable while neutralizing terminal controls and invisible direction changes. */
function safeText(value: string): string {
  return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[@-_])?/g, '[control]')
    .replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '�');
}

/** Scans retained history through a frozen sequence and refuses known missing bodies or pages. */
export async function exportHistory(client: ObservationClient, target: { kind: 'session'; id: string } | { kind: 'pool'; id: string }, signal?: AbortSignal): Promise<string> {
  if (!target.id || (target.kind !== 'session' && target.kind !== 'pool')) throw new Error('Invalid history target');
  const id = target.id;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, TIMEOUT_MS);
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let bytes = 0;
  let pages = 0;
  /** Appends only while the final UTF-8 export remains within its byte budget. */
  function append(text: string): void {
    bytes += encoder.encode(text).length;
    if (bytes > MAX_BYTES) throw new Error('History exceeds export byte limit');
    chunks.push(text);
  }
  /** Performs a correlated, cancellable read with a total page budget. */
  async function read(resource: Resource, params: Record<string, unknown>): Promise<unknown> {
    if (controller.signal.aborted) throw new Error('History export cancelled or timed out');
    if (++pages > MAX_PAGES) throw new Error('History exceeds export page limit');
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('History export cancelled or timed out'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const envelope = response(await Promise.race([client.read(resource, params, controller.signal), aborted]), resource);
      if (controller.signal.aborted) throw new Error('History export cancelled or timed out');
      if (envelope.error !== null || !['ok', 'partial'].includes(envelope.outcome)) throw new Error('History source unavailable or incomplete');
      if (independentlyPartial(envelope)) throw new Error('History source coverage is incomplete');
      return envelope.data;
    } finally {
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }
  try {
    if (target.kind === 'session') {
      const tail = transcriptPage(await read('run.transcript', { agent_id: id, view: 'blocks', tail_blocks: 1 }), id);
      if (tail.raw.view !== 'blocks' || !('resume_cursor' in tail.raw)) throw new Error('Unknown transcript watermark');
      const watermark = tail.raw.resume_cursor === null && tail.blocks.length === 0 ? 0 : integer(tail.raw.resume_cursor);
      if ((watermark === 0) !== (tail.blocks.length === 0) || (watermark === 0 && !tail.complete) || (watermark > 0 && tail.blocks.at(-1)?.seq !== watermark)) throw new Error('Invalid transcript watermark');
      append(`agent-run transcript ${safeJson(id)}\nScope: retained logical session history across executions\nScan through #${watermark}; concurrent retention may remove earlier records, so completeness is not guaranteed.\n\n`);
      const blocks: TranscriptBlock[] = []; let sourceBytes = 0;
      let cursor = 0;
      while (cursor < watermark) {
        const page = transcriptPage(await read('run.transcript', { agent_id: id, cursor, limit: 1000 }), id);
        if (page.raw.cursor !== cursor) throw new Error('Invalid transcript cursor');
        const before = cursor;
        for (const block of page.blocks) {
          if (block.seq <= cursor) throw new Error('Transcript sequence did not advance');
          if (block.seq > watermark) break;
          if (block.raw.content_complete !== true || (block.raw.omitted_bytes != null && block.raw.omitted_bytes !== 0) || block.raw.partial_before === true || block.raw.partial_after === true) throw new Error('Transcript body is incomplete or unknown');
          sourceBytes += encoder.encode(block.content).length;
          if (sourceBytes > MAX_BYTES) throw new Error('History exceeds export byte limit');
          blocks.push(block);
          cursor = block.seq;
        }
        if (cursor === watermark) break;
        if (cursor === before || page.complete || page.raw.next_cursor !== cursor) throw new Error('Transcript continuation unavailable');
      }
      for (const entry of groupTranscript(blocks).entries) {
        const name = typeof entry.head.raw.name === 'string' ? ` · ${safeText(entry.head.raw.name)}` : '';
        if (entry.calls.length || entry.results.length) {
          const status = entry.results.some(block => block.raw.error === true) ? 'error' : entry.results.length && entry.results.every(block => block.raw.error === false) ? 'ok' : 'unknown';
          append(`Tool${name} · ${status}\n`);
          if (entry.calls.length) append(`Input:\n${safeText(entry.calls.map(block => block.content).join(''))}\n`);
          if (entry.results.length) append(`Output:\n${safeText(entry.results.map(block => block.content).join(''))}\n`);
        } else append(`${safeText(entry.head.role)}${name}:\n${safeText(entry.head.content)}\n`);
        append('\n');
      }
    } else {
      const identity = product(await read('pool.identity', {}), 'identity');
      if (!Array.isArray(identity.capabilities) || !identity.capabilities.includes('history_window_v1')) throw new Error('Pool history watermark is unsupported');
      const tail = poolWindow(await read('pool.get', { pool_id: id, section: 'history', direction: 'backward' }), id, 'backward', null, null);
      const watermark = tail.watermark;
      if (tail.entries.length ? tail.entries.at(-1)?.event_id_exact !== watermark : watermark !== '0') throw new Error('Invalid pool watermark');
      append(`agent-pool journal ${safeJson(id)}\nJournal snapshot through #${watermark}; other pool sections are not frozen.\n\n`);
      let cursor = '0', sourceBytes = 0; const events: Record<string, unknown>[] = [];
      while (cursor !== watermark) {
        const page = poolWindow(await read('pool.get', { pool_id: id, section: 'history', direction: 'forward', after: cursor, through: watermark }), id, 'forward', cursor, watermark);
        for (const entry of page.entries) {
          sourceBytes += encoder.encode(String(entry.body)).length;
          if (sourceBytes > MAX_BYTES) throw new Error('History exceeds export byte limit');
          events.push(entry);
        }
        if (page.cursor === cursor || (!page.more && page.cursor !== watermark)) throw new Error('Pool continuation unavailable');
        cursor = page.cursor;
      }
      for (const group of groupPoolEvents(events)) {
        if (!group.complete) throw new Error('Pool message parts are incomplete or inconsistent');
        const entry = group.head, author = object(entry.author), kind = typeof author.kind === 'string' ? safeText(author.kind) : 'unknown';
        const member = typeof author.member_id === 'string' ? ` ${safeText(author.member_id)}` : '';
        append(`#${entry.event_id_exact} · ${kind}${member} · ${safeText(String(entry.kind))}\n${safeText(group.parts.map(part => String(part.body)).join(''))}\n\n`);
      }
    }
    if (controller.signal.aborted) throw new Error('History export cancelled or timed out');
    return chunks.join('');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}
