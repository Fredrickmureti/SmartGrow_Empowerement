/**
 * Lightweight error-reporting shim used by the TanStack root error boundary.
 *
 * Always logs to the console; when running inside the Lovable preview iframe
 * it also posts a structured message to the parent so the platform can
 * surface the error in the editor. No domain dependencies — this must stay
 * safe to import from `src/routes/__root.tsx`.
 */

export type LovableErrorContext = Record<string, unknown>;

export function reportLovableError(
  error: unknown,
  context: LovableErrorContext = {},
): void {
  const err =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: 'NonError', message: String(error) };

  // Local visibility — always.
  // eslint-disable-next-line no-console
  console.error('[lovable:error]', err, context);

  // Preview iframe bridge — best-effort, never throws.
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: 'lovable:error', error: err, context, ts: Date.now() },
        '*',
      );
    }
  } catch {
    /* ignore — reporting must never break the app */
  }
}
