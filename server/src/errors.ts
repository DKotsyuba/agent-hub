/** Safe HTTP error classification independent of producer diagnostic text. */
import { ERROR_STATUS, type ErrorCode, type RouteName } from '@agent-hub/domain';
import type { NativeResponse, ObserverResource } from './observer.ts';

const messages: Record<ErrorCode, string> = {
  invalid_request: 'Invalid request.', forbidden: 'Action not permitted.', not_found: 'Resource not found.',
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
export function errorResponse(error: unknown, requestId = crypto.randomUUID()): Response {
  const code = error instanceof HubError ? error.code : 'invalid_projection';
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (code === 'method_not_allowed') headers.set('Allow', 'GET');
  return Response.json({ error: {
    code, message: messages[code], requestId,
    retryable: code === 'source_unavailable' || code === 'saturated' || code === 'stale_boundary',
  } }, { status: ERROR_STATUS[code], headers });
}

/** Reports a native call through its initiating request or SSE poll. */
export type ReadFailureReporter = (resource: ObserverResource, failure: NativeResponse | 'invalid_projection' | 'read_rejected') => void;

/** Logs a failed source read using only server-owned classifications and identifiers. */
export function logSourceFailure(route: RouteName, requestId: string, resource: ObserverResource,
  failure: NativeResponse | 'invalid_projection' | 'read_rejected'): void {
  const code = typeof failure === 'string' ? failure : failure.error?.code;
  const errorClass = typeof failure === 'string' ? failure : [
    'run_inventory_storage', 'run_method_unavailable', 'run_source_error',
    'run_agent_missing', 'client_timeout', 'observer_timeout', 'observer_exit',
    'observer_start', 'observer_protocol',
  ].find(known => known === code) ?? failure.outcome;
  console.error(JSON.stringify({ event: 'source_failure', route, source: resource.split('.')[0], resource, errorClass, requestId }));
}
