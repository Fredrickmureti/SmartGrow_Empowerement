/**
 * dialogReadyBus — Plan P5.
 *
 * Tiny in-memory pub/sub the Sales scan flow uses to know *exactly*
 * when a freshly-triggered Create dialog has finished mounting and
 * registered its scan controller. Replaces the historical 600 ms
 * `setTimeout` guard in `Invoices.openDraftFromScan` that races with
 * the dialog mount on slow devices.
 *
 * Producers: dialog components publish `dialogReadyBus.signal(scope)`
 * inside an effect that runs once their scan controller is registered.
 *
 * Consumers: scan-to-open handlers `await dialogReadyBus.waitFor(scope,
 * timeoutMs)`. Returns true if the dialog is ready in time, false on
 * timeout — caller decides whether to clean up.
 */

type Scope = string;

const waiters = new Map<Scope, Set<() => void>>();

export const dialogReadyBus = {
  signal(scope: Scope): void {
    const set = waiters.get(scope);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(); } catch (err) { console.error("[dialogReadyBus] waiter", err); }
    }
  },
  /**
   * Resolve with `true` when the next `signal(scope)` arrives, or `false`
   * if `timeoutMs` elapses first. Always cleans up its waiter slot.
   */
  waitFor(scope: Scope, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        const set = waiters.get(scope);
        if (set) {
          set.delete(notify);
          if (set.size === 0) waiters.delete(scope);
        }
        window.clearTimeout(handle);
        resolve(ok);
      };
      const notify = () => finish(true);
      const set = waiters.get(scope) ?? new Set();
      set.add(notify);
      waiters.set(scope, set);
      const handle = window.setTimeout(() => finish(false), timeoutMs);
    });
  },
  /** Test helper. */
  _clear(): void {
    waiters.clear();
  },
};
