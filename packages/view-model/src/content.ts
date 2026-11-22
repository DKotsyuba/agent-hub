/** Validates byte-contiguous text without depending on a renderer or HTTP client. */
import type { textChunk } from '../../domain/src/index.ts';

/** A page of text with a caller-defined identity or revision fence. */
export interface TextPage {
  content: ReturnType<typeof textChunk>;
  fence: string;
  next: string | null;
}

/** Assembles a fixed UTF-8 payload. A failure discards every accumulated page. */
export async function assembleText(
  read: (cursor: string | null) => Promise<TextPage>,
  signal?: AbortSignal,
  maxBytes = 16 * 1024 * 1024,
): Promise<string> {
  const encoder = new TextEncoder();
  const parts: string[] = [], seen = new Set<string>();
  let cursor: string | null = null, fence: string | undefined, total: number | undefined, offset = 0;
  do {
    signal?.throwIfAborted();
    const page = await read(cursor);
    signal?.throwIfAborted();
    const { content, next } = page;
    fence ??= page.fence;
    total ??= content.totalBytes;
    const bytes = encoder.encode(content.text).length;
    if (page.fence !== fence || content.offsetBytes !== offset || content.totalBytes !== total ||
        total > maxBytes || offset + bytes > total || (next === null) !== (offset + bytes === total) ||
        (next !== null && (bytes === 0 || seen.has(next) || seen.size >= 4096))) throw new Error('content_boundary_changed');
    parts.push(content.text);
    offset += bytes;
    if (next !== null) seen.add(next);
    cursor = next;
  } while (cursor !== null);
  return parts.join('');
}

/** Verifies an assembled projection against its reported SHA-256. */
export async function verifyText(text: string, expected: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  if (Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') !== expected) throw new Error('content_digest_mismatch');
  return text;
}
