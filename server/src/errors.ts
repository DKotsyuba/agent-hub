/** Safe HTTP error classification independent of producer diagnostic text. */
import { ERROR_STATUS, type ErrorCode } from '@agent-hub/domain';

const messages: Record<ErrorCode, string> = {
  invalid_request: 'Invalid request.', not_found: 'Resource not found.',
  method_not_allowed: 'Only GET is supported.', stale_boundary: 'Reload this resource boundary.',
  unsupported_capability: 'Producer capability unavailable.', saturated: 'Read capacity exceeded.',
  invalid_projection: 'Invalid source response.', source_unavailable: 'Source temporarily unavailable.',
};

/** Carries only a public machine error across the HTTP boundary. */
export class HubError extends Error {
  /** Classifies a failed read without retaining raw source error text. */
  constructor(readonly code: ErrorCode) { super(messages[code]); }
}

/** Produces a safe response even when an unexpected exception escaped a projection. */
export function errorResponse(error: unknown): Response {
  const code = error instanceof HubError ? error.code : 'invalid_projection';
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (code === 'method_not_allowed') headers.set('Allow', 'GET');
  return Response.json({ error: {
    code, message: messages[code], requestId: crypto.randomUUID(),
    retryable: code === 'source_unavailable' || code === 'saturated' || code === 'stale_boundary',
  } }, { status: ERROR_STATUS[code], headers });
}
