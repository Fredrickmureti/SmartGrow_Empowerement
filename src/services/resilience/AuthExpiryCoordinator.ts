/**
 * AuthExpiryCoordinator
 *
 * Single point that responds to `auth_expired` errors anywhere in the
 * app. When the first 401 arrives:
 *   1. show ONE toast ("Your session expired. Please sign in again.")
 *   2. call `supabase.auth.signOut({ scope: 'local' })`
 *   3. navigate to `/login?reason=session_expired`
 *
 * Subsequent 401s within `SUPPRESSION_MS` are swallowed so that 20
 * concurrent hooks don't fire 20 toasts and 20 navigations.
 *
 * The coordinator is invoked from `ErrorNormalizer` when it produces an
 * `auth_expired` kind. Call sites do not need to know it exists.
 */

const SUPPRESSION_MS = 30_000;

type Notify = (message: { title: string; description: string }) => void;

class AuthExpiryCoordinatorImpl {
  private lastFiredAt = 0;
  private notify: Notify | null = null;
  private signOut: (() => Promise<void>) | null = null;
  private redirect: (() => void) | null = null;

  /** Wire UI side-effects from the React tree. Called once at app boot. */
  configure(opts: { notify: Notify; signOut: () => Promise<void>; redirect: () => void }) {
    this.notify = opts.notify;
    this.signOut = opts.signOut;
    this.redirect = opts.redirect;
  }

  isSuppressed(): boolean {
    return Date.now() - this.lastFiredAt < SUPPRESSION_MS;
  }

  /** Called by ErrorNormalizer when it produces `auth_expired`. */
  trigger(): void {
    if (this.isSuppressed()) return;
    this.lastFiredAt = Date.now();

    try {
      this.notify?.({
        title: "Session expired",
        description: "Your session expired. Please sign in again.",
      });
    } catch { /* notify is best-effort */ }

    void (async () => {
      try { await this.signOut?.(); } catch { /* ignore */ }
      try { this.redirect?.(); } catch { /* ignore */ }
    })();
  }

  /** Test-only. */
  _resetForTests() {
    this.lastFiredAt = 0;
    this.notify = null;
    this.signOut = null;
    this.redirect = null;
  }
}

export const authExpiryCoordinator = new AuthExpiryCoordinatorImpl();
export type AuthExpiryCoordinator = typeof authExpiryCoordinator;
