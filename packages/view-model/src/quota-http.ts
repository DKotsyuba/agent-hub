/** Projects v1 Quota DTOs into the existing time-in-seconds presentation model. */
import type { Quota } from '../../domain/src/index.ts';
import type { QuotaSnapshot, QuotaStatus } from './quota.ts';

/** Converts nullable epoch milliseconds to nullable epoch seconds. */
function seconds(value: number | null): number | null {
  return value === null ? null : value / 1000;
}

/** Preserve independent forecasts, clocks and exhaustion latches for each account. */
export function projectQuotaSnapshot(snapshot: NonNullable<Quota['snapshot']>): QuotaSnapshot {
  return {
    ...snapshot, evaluatedAt: seconds(snapshot.evaluatedAtMs),
    coverage: { ...snapshot.coverage, lastCollectionAt: seconds(snapshot.coverage.lastCollectionAtMs) },
    accounts: snapshot.accounts.map(account => ({
      ...account,
      models: account.models.map(model => ({
        ...model, validity: model.validity.kind === 'until' ? { kind: 'until', at: model.validity.atMs / 1000 } : model.validity,
        resetAt: seconds(model.resetAtMs), newestObservedAt: seconds(model.newestObservedAtMs),
        exhaustedUntil: seconds(model.exhaustedUntilMs),
      })),
      windows: account.windows.map(window => ({
        ...window, observedAt: seconds(window.observedAtMs), validUntil: seconds(window.validUntilMs), lastResetAt: seconds(window.lastResetAtMs),
      })),
      latches: account.latches.map(latch => ({ ...latch, observedAt: seconds(latch.observedAtMs), resetAt: seconds(latch.resetAtMs) })),
    })),
  };
}

/** Keep service health independent of the availability of account measurements. */
export function projectQuotaStatus(status: NonNullable<Quota['status']>): QuotaStatus {
  return {
    ...status, startedAt: seconds(status.startedAtMs), lastCollectionAt: seconds(status.lastCollectionAtMs),
    external: status.external.map(row => ({ ...row, acceptedAt: seconds(row.acceptedAtMs) })),
  };
}
