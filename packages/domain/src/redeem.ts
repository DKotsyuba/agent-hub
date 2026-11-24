/** Contract of the single mutating Hub action: redeeming one banked Agent Quota reset credit. */
import { type Decoded, count, invalid, matching, nullable, object, oneOf, text } from './schema.ts';
import { API_PREFIX } from './common.ts';

/** Collection path of the only POST route. */
export const REDEEM_PATH = `${API_PREFIX}/quota/redeem`;

/** Required on every redeem POST so a simple cross-site form cannot reach the action. */
export const REDEEM_HEADER = 'X-Agent-Hub-Action';
export const REDEEM_HEADER_VALUE = 'redeem';

/** Request IDs are server-generated UUID v4 values. */
export const REQUEST_ID = matching(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/, 'request UUID v4');

/** Account and credit identifiers are bounded printable ASCII tokens; paths and whitespace never qualify. */
export const REDEEM_TOKEN = matching(/[A-Za-z0-9][A-Za-z0-9._:@+=-]{0,127}/, 'account or credit identifier');

/** Lifecycle states reported by Agent Quota; `unknown` also covers an uncertain transport outcome. */
export const REDEEM_STATES = ['pending', 'redeemed', 'rejected', 'unknown', 'failed'] as const;

/** One redeem attempt as recorded by Agent Quota. Clocks are Unix seconds. */
export const redeemRecord = object({
  request_id: REQUEST_ID, account: text, credit_id: text, state: oneOf(...REDEEM_STATES),
  reason: nullable(text), created_at: count, updated_at: count,
});

/** A decoded redeem attempt. */
export type RedeemRecord = Decoded<typeof redeemRecord>;

/** Terminal states never change; `pending` and `unknown` may still resolve. */
export function redeemSettled(state: RedeemRecord['state']): boolean {
  return state === 'redeemed' || state === 'rejected' || state === 'failed';
}

/** Validates the strict POST body: exactly `account` and `credit_id`, nothing else. */
export function redeemRequest(value: unknown): { account: string; credit_id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('$', 'object');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('account') || !keys.includes('credit_id')) return invalid('$', 'account and credit_id only');
  const fields = value as Record<string, unknown>;
  return { account: REDEEM_TOKEN(fields.account, '$.account'), credit_id: REDEEM_TOKEN(fields.credit_id, '$.credit_id') };
}
