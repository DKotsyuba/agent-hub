/** Fixture-only cursor implementation for immutable scenario data. */
import { type RouteName, opaque } from '../../domain/src/index.ts';
import { type Decoder, count, object, oneOf, text } from '../../domain/src/schema.ts';
import { FixtureError } from './response.ts';

/** Internal pagination modes including a live catch-up position. */
const cursorMode = oneOf('next', 'previous', 'resume');

/** Fields encoded in fixture cursors. Production cursors belong to B. */
const cursorDecoder = object({ scenario: text, boundary: text, query: text, offset: count, mode: cursorMode });

/** Request shape shared by paginated fixture arrays. */
type PageRequest = {
  route: RouteName; limit: number; cursor: string | null;
  edge?: 'start' | 'tail' | null; direction?: 'older' | 'newer' | null;
};

/** Resolves and validates the position against the current scenario, request and immutable snapshot. */
export function fixtureCursor(request: PageRequest, scenario: string, boundary: string, size: number, forwardOnly: boolean) {
  const { cursor, ...query } = request;
  const history = 'edge' in query ? query : null;
  // An explicit direction chooses how to consume the token, not a different resource query.
  const normalized = JSON.stringify(history ? { ...query, direction: null } : query);
  const encode = (mode: ReturnType<typeof cursorMode>, offset: number) =>
    opaque(encodeCursor(JSON.stringify({ scenario, boundary, query: normalized, offset, mode })));
  let ceiling = size;
  let offset = history?.edge === 'tail' && !forwardOnly ? Math.max(0, size - request.limit) : 0;
  if (cursor !== null) {
    const token = decodeCursor(cursor, cursorDecoder);
    if (token.query !== normalized) throw new FixtureError('invalid_request');
    if (token.scenario !== scenario || token.boundary !== boundary || token.offset > size) throw new FixtureError('stale_boundary');
    if (history?.direction && (history.direction === 'older') !== (token.mode === 'previous')) throw new FixtureError('invalid_request');
    if (token.mode === 'previous') ceiling = token.offset;
    offset = token.mode === 'previous' ? Math.max(0, token.offset - request.limit) : token.offset;
  } else if (history?.direction) {
    throw new FixtureError('invalid_request');
  }
  if (history && forwardOnly && (history.edge === 'tail' || history.direction === 'older')) {
    throw new FixtureError('unsupported_capability');
  }
  // On an older hop, the oldest page may be shorter than the requested limit.
  const stop = Math.min(offset + request.limit, ceiling);
  return {
    offset,
    stop,
    page: {
      next: stop < size ? encode('next', stop) : null,
      previous: offset && !forwardOnly ? encode('previous', offset) : null,
      resume: history ? encode('resume', stop) : null,
    },
  };
}

/** Encodes small fixture cursors with APIs shared by browsers and Bun. */
function encodeCursor(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Rejects malformed cursor data at the request boundary. */
function decodeCursor<T>(cursor: string, decode: Decoder<T>): T {
  try {
    const binary = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (encodeCursor(text) !== cursor) throw new Error('Malformed cursor');
    return decode(JSON.parse(text));
  } catch {
    throw new FixtureError('invalid_request');
  }
}
