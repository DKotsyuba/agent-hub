/** HTTP responses shared by fixture routes and the SSE handler. */
import { type ApiError, type ErrorCode, ERROR_STATUS } from '../../domain/src/index.ts';

/** Stable safe response messages. Clients can localize using the machine code. */
const MESSAGES: Record<ErrorCode, string> = {
  invalid_request: 'The request contains invalid parameters.',
  not_found: 'The requested observation was not found.',
  method_not_allowed: 'Only GET is available.',
  stale_boundary: 'The boundary changed. Reload the relevant view.',
  unsupported_capability: 'The producer does not support this read.',
  saturated: 'The observer is busy.',
  invalid_projection: 'The producer returned invalid observation data.',
  source_unavailable: 'The source is temporarily unavailable.',
};

/** Expected request failure with a safe HTTP code. */
export class FixtureError extends Error {
  readonly code: ErrorCode;

  /** Captures the machine code corresponding to the canonical v1 HTTP status. */
  constructor(code: ErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

/** Returns a canonical JSON error without echoing any input. */
export function errorResponse(code: ErrorCode): Response {
  const body: ApiError = {
    error: {
      code, message: MESSAGES[code], requestId: crypto.randomUUID(),
      retryable: code === 'stale_boundary' || code === 'saturated' || code === 'source_unavailable',
    },
  };
  return Response.json(body, {
    status: ERROR_STATUS[code], headers: { 'Cache-Control': 'no-store', ...(code === 'method_not_allowed' ? { Allow: 'GET' } : {}) },
  });
}
