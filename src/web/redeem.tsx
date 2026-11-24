/** Owner-initiated redemption of one banked reset credit: the Hub's only mutating control. */
import { useContext, useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { LiveContext, redeemClient } from './data';
import { awaitRedeem, HubHttpError, redeemOutcome } from './client';
import { useWebText } from './ui';

/** The credit the owner is about to spend, with the texts shown in the confirmation. */
export interface RedeemTarget {
  account: string; accountTitle: string; creditId: string; name: string; scope: string; expiry: string;
}

/** What the inline status line shows for the latest attempt. */
export type RedeemState =
  | { phase: 'idle' }
  | { phase: 'working' }
  | { phase: 'done'; kind: 'redeemed' | 'failed' | 'unknown'; reason?: string };

/** Server refusals that mean nothing was spent; any other failure leaves the outcome unknown. */
const REFUSED = new Set(['forbidden', 'invalid_request', 'unsupported_capability', 'saturated']);

/** Owns the confirmed attempt for one account: POST once, poll, then refresh quota data. */
export function useRedeem() {
  const { requestRefresh } = useContext(LiveContext);
  const [state, setState] = useState<RedeemState>({ phase: 'idle' });
  const controller = useRef<AbortController | null>(null);
  // Leaving the view stops waiting; the server-side attempt continues and can be read later.
  useEffect(() => () => controller.current?.abort(), []);

  /** Sends the single request for a confirmed target. */
  async function start(target: RedeemTarget) {
    if (controller.current && !controller.current.signal.aborted && state.phase === 'working') return;
    const own = new AbortController();
    controller.current = own;
    setState({ phase: 'working' });
    let result: RedeemState;
    try {
      const first = await redeemClient.redeem(target.account, target.creditId, own.signal);
      const last = await awaitRedeem(first, { status: redeemClient.status, signal: own.signal });
      const outcome = redeemOutcome(last);
      result = outcome.kind === 'failed' ? { phase: 'done', kind: 'failed', reason: outcome.reason ?? undefined }
        : { phase: 'done', kind: outcome.kind === 'redeemed' ? 'redeemed' : 'unknown' };
    } catch (error) {
      if (own.signal.aborted) return;
      result = error instanceof HubHttpError && REFUSED.has(error.code) ? { phase: 'done', kind: 'failed', reason: error.code }
        : { phase: 'done', kind: 'unknown' };
    }
    setState(result);
    requestRefresh?.();
  }
  return { state, start };
}

/** The small per-group trigger; the confirmation dialog states exactly what will be spent. */
export function RedeemButton({ target, busy, onConfirm }: { target: RedeemTarget; busy: boolean; onConfirm: (target: RedeemTarget) => void }) {
  const { label } = useWebText();
  const [open, setOpen] = useState(false);
  const facts: [string, string][] = [['Account', target.accountTitle], ['Reset', target.name],
    ['Redeem refills', target.scope], ['Redeem expiry', target.expiry]];
  return <>
    <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={busy}
      aria-label={label('Redeem reset') + ' · ' + target.name} aria-busy={busy || undefined} onClick={() => setOpen(true)}>
      {busy && <LoaderCircle className="web-spin" aria-hidden="true" />}{busy ? label('Redeem applying') : label('Redeem reset')}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent role="alertdialog" className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{label('Redeem title')}</DialogTitle>
          <DialogDescription>{label('Redeem warning')}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {facts.map(([name, value]) => <div key={name} className="contents">
            <dt className="web-muted">{label(name)}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>)}
        </dl>
        <DialogFooter className="gap-2 sm:gap-0">
          <DialogClose asChild><Button type="button" variant="outline" autoFocus>{label('Cancel')}</Button></DialogClose>
          <Button type="button" onClick={() => { setOpen(false); onConfirm(target); }}>{label('Redeem reset')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

/** Inline, announced outcome of the latest attempt. Reasons come from the producer and are shown as plain text. */
export function RedeemStatus({ state }: { state: RedeemState }) {
  const { label } = useWebText();
  if (state.phase === 'idle') return null;
  const text = state.phase === 'working' ? label('Redeem applying')
    : state.kind === 'redeemed' ? label('Redeem done')
      : state.kind === 'unknown' ? label('Redeem unknown')
        : state.reason ? label(state.reason.slice(0, 200)) : label('Redeem failed');
  const tone = state.phase === 'done' && state.kind === 'failed' ? 'web-warning' : 'web-muted';
  return <p className={tone + ' mt-1.5 text-sm'} role="status" aria-live="polite">
    {state.phase === 'working' && <LoaderCircle className="web-spin inline" size={14} aria-hidden="true" />} {text}</p>;
}
