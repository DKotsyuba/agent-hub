/** Owns service-worker registration and the user-triggered change of controller. */
import { useEffect, useRef, useState } from 'react';

/** Waits for an in-flight installation to settle, bounded by the caller's signal. */
function installation(worker: ServiceWorker, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const settle = () => {
      if (worker.state !== 'installing') resolve();
    };
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    worker.addEventListener('statechange', settle, { signal });
    settle();
  });
}

/** Registers the production SW, tracks waiting updates and reloads after explicit activation. */
export function useAppUpdate() {
  const [waiting, setWaiting] = useState(false);
  const [reloadPending, setReloadPending] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState(false);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return;
    const events = new AbortController();
    const { signal } = events;
    const service = navigator.serviceWorker;
    let controller = service.controller;
    const controllerChanged = () => {
      const next = service.controller;
      if (controller && next && controller !== next) setReloadPending(true);
      controller = next;
      check();
    };
    service.addEventListener('controllerchange', controllerChanged, { signal });
    const watched = new WeakSet<ServiceWorker>();
    const check = () => {
      const installed = registration.current?.waiting;
      setWaiting(!!installed && !!service.controller);
    };
    const watch = () => {
      check();
      const worker = registration.current?.installing;
      if (!worker || watched.has(worker)) return;
      watched.add(worker);
      worker.addEventListener('statechange', check, { signal });
    };
    const update = () => {
      if (!document.hidden) void registration.current?.update().catch(() => {});
    };
    void service.register('/sw.js', { updateViaCache: 'none' }).then(reg => {
      if (signal.aborted) return;
      registration.current = reg;
      reg.addEventListener('updatefound', watch, { signal });
      watch();
      update();
    }).catch(() => { /* The web app remains readable when native SW support is unavailable. */ });
    document.addEventListener('visibilitychange', update, { signal });
    window.addEventListener('online', update, { signal });
    const poll = window.setInterval(update, 60_000);
    return () => {
      events.abort();
      operation.current?.abort();
      registration.current = null;
      window.clearInterval(poll);
    };
  }, []);

  /** Requests the newest worker, then reloads only after it takes control. */
  async function activate() {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    setUpdating(true);
    setError(false);
    try {
      if (reloadPending) {
        location.reload();
        return;
      }
      const reg = registration.current;
      if (reg && !reg.waiting) {
        await reg.update();
        if (reg.installing) await installation(reg.installing, signal);
      }
      signal.throwIfAborted();
      const worker = reg?.waiting;
      if (!worker) {
        location.reload();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (navigator.serviceWorker.controller === worker) resolve();
        }, { signal });
        worker.postMessage('SKIP_WAITING');
      });
      location.reload();
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      controller.abort();
      operation.current = null;
      setUpdating(false);
    }
  }

  return { waiting: waiting || reloadPending, updating, error, activate };
}
