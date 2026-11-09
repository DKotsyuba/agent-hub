/** Execution-fenced Run history and proof-bound answers; no artifact filesystem fallback. */
import { useEffect, useRef, useState } from 'react';
import { read, readCurrent, watch } from './native';
import { answerText, failure, mergeBlocks, supportsChunks, transcriptPage, usable, object } from './protocol';
import { useVisible } from './hooks';
import type { Observation } from './hooks';
import type { Cursor, ReadResponse, RunAgent, TranscriptBlock } from './protocol';

/** Plain-text history state, with source cursors rather than guessed offsets. */
export interface HistoryState {
  /** Execution identity owning these messages. */
  key: string;
  /** Deduplicated producer blocks in sequence order. */
  blocks: TranscriptBlock[];
  /** Source older-page cursor, absent when there is no older continuation. */
  previous: Cursor | null;
  /** Latest native response, including source errors. */
  response: ReadResponse | null;
  /** Initial/tail read state. */
  loading: boolean;
  /** Explicit older read state; duplicate clicks cannot overlap. */
  older: boolean;
  /** Producer history coverage. */
  complete: boolean;
  /** Requests older history, preserving the reader's current visual position. */
  loadOlder: () => void;
}
/** Owns tail-first history and cursor-forward watches; execution changes fence every reply. */
export function useTranscript(agentId: string, sequence: number | null, refresh: number, enabled: boolean): HistoryState {
  const key = JSON.stringify([agentId, sequence]);
  const visible = useVisible();
  const olderAction = useRef<() => void>(() => {});
  const [state, setState] = useState<Omit<HistoryState, 'loadOlder'>>({ key, blocks: [], previous: null, response: null, loading: true, older: false, complete: false });
  useEffect(() => {
    if (!enabled || !visible) return;
    let active = true; let olderBusy = false; let previous: Cursor | null = null; let forward: Cursor | null = null; let stopForward = () => {};
    setState(value => ({ key, blocks: value.key === key ? value.blocks : [], previous: null, response: null, loading: true, older: false, complete: false }));
    /** Incoming pages retain producer block identity/completeness and never force scrolling. */
    const accept = (envelope: ReadResponse, tail = false) => {
      if (!active) return;
      if (!usable(envelope)) { setState(value => ({ ...value, response: envelope, loading: false, older: false })); return; }
      try {
        const page = transcriptPage(envelope.data, agentId);
        if (tail) previous = page.previous;
        setState(value => ({ ...value, blocks: mergeBlocks(value.blocks, page.blocks), response: envelope, previous, loading: false, complete: page.complete }));
        if (page.resume !== null && page.resume !== forward) startForward(page.resume);
      } catch { setState(value => ({ ...value, response: failure('run.transcript', 'transcript_schema'), loading: false, older: false })); }
    };
    /** A forward cursor change replaces the old subscription; no renderer interval is created. */
    const startForward = (cursor: Cursor) => { if (!active) return; stopForward(); forward = cursor; stopForward = watch({ resource: 'run.transcript', params: { agent_id: agentId, view: 'blocks', cursor } }, value => accept(value)); };
    olderAction.current = () => {
      if (!active || olderBusy || previous === null) return;
      olderBusy = true; const before = previous; const height = document.documentElement.scrollHeight; const position = window.scrollY;
      setState(value => ({ ...value, older: true }));
      void read({ resource: 'run.transcript', params: { agent_id: agentId, view: 'blocks', before_cursor: before } }).then(envelope => {
        if (!active) return;
        if (!usable(envelope)) { setState(value => ({ ...value, response: envelope, older: false })); return; }
        try {
          const page = transcriptPage(envelope.data, agentId); previous = page.previous;
          setState(value => ({ ...value, blocks: mergeBlocks(value.blocks, page.blocks), previous, response: envelope, older: false }));
          requestAnimationFrame(() => { if (active) window.scrollTo({ top: position + Math.max(0, document.documentElement.scrollHeight - height), behavior: 'instant' }); });
        } catch { setState(value => ({ ...value, response: failure('run.transcript', 'transcript_schema'), older: false })); }
      }).finally(() => { olderBusy = false; });
    };
    void readCurrent({ resource: 'run.transcript', params: { agent_id: agentId, view: 'blocks', tail_blocks: 40 } }, () => active).then(value => accept(value, true));
    return () => { active = false; olderAction.current = () => {}; stopForward(); };
  }, [key, refresh, enabled, visible]);
  const current = state.key === key ? state : { key, blocks: [], previous: null, response: null, loading: true, older: false, complete: false };
  return { ...current, loadOlder: () => olderAction.current() };
}
/** Complete answer content is exposed only after required producer/hash attribution succeeds. */
export interface AnswerState extends Observation {
  /** Complete attributed text, null for unavailable/unsupported/unverified/in-progress answers. */
  content: string | null;
  /** Stable renderer-owned reason when a source proof cannot be established. */
  issue: string | null;
}
/** Lazily reads answer metadata and only discovered proof-bound chunks, fenced by execution/hash. */
export function useAnswer(agentId: string, agent: RunAgent | null, refresh: number, enabled: boolean): AnswerState {
  const key = JSON.stringify([agentId, agent?.sequence ?? null, agent?.answerSha ?? null]);
  const visible = useVisible();
  const [state, setState] = useState<AnswerState>({ key, response: null, good: null, loading: true, content: null, issue: null });
  useEffect(() => {
    if (!enabled || !visible) return;
    let active = true;
    setState({ key, response: null, good: null, loading: true, content: null, issue: null });
    /** Metadata and chunks use only the closed native reads, never the returned path/raw_ref. */
    async function load() {
      const envelope = await readCurrent({ resource: 'run.answer', params: { agent_id: agentId } }, () => active);
      if (!active) return;
      if (!usable(envelope)) { setState({ key, response: envelope, good: null, loading: false, content: null, issue: null }); return; }
      try {
        const metadata = object(envelope.data);
        const discovery = metadata.available === true && metadata.inline_complete !== true ? await readCurrent({ resource: 'run.identity', params: {} }, () => active) : null;
        if (!active) return;
        const support = discovery !== null && usable(discovery) && supportsChunks(discovery.data);
        const content = await answerText(envelope.data, agentId, agent?.sequence ?? null, agent?.answerSha ?? null, support, async params => { const chunk = await read({ resource: 'run.answer_chunk', params }); if (!usable(chunk)) throw new Error('answer_chunk_unavailable'); return chunk.data; }, () => active);
        if (active) setState({ key, response: envelope, good: envelope, loading: false, content, issue: null });
      } catch (error) { if (active) setState({ key, response: envelope, good: envelope, loading: false, content: null, issue: error instanceof Error ? error.message : 'answer_proof' }); }
    }
    void load();
    return () => { active = false; };
  }, [key, refresh, enabled, visible]);
  return state.key === key ? state : { key, response: null, good: null, loading: true, content: null, issue: null };
}
