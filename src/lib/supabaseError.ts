/**
 * Normalizes Supabase (PostgREST) failures into real `Error` instances.
 *
 * Why this exists: `supabase.rpc()` and `.from()` return their failure as a
 * `PostgrestError` *plain object* — `{ message, details, hint, code }` — not an
 * `Error`. Code that does `throw error` therefore rejects with a non-Error
 * value, and every downstream `e instanceof Error ? e.message : "<generic>"`
 * check falls to the generic branch. The database's carefully worded refusal
 * (which names the exact pair, amount, rate class or mapping at fault) is
 * discarded and the user is left with an unactionable message.
 *
 * `toAppError` keeps the server's own words: the message, plus `details` and
 * `hint` when the server supplied them, with `code` retained on the Error for
 * callers that branch on the SQLSTATE.
 */

export interface AppError extends Error {
  /** Postgres SQLSTATE / PostgREST code, when the failure carried one. */
  code?: string;
  details?: string;
  hint?: string;
}

interface PostgrestErrorShape {
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  code?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Convert any thrown/returned Supabase failure into an `Error` whose `message`
 * carries the full server explanation. Already-`Error` values pass through
 * untouched so stacks and subclasses survive.
 */
export function toAppError(error: unknown, fallbackMessage = "Request failed"): AppError {
  if (error instanceof Error) return error as AppError;

  if (error && typeof error === "object") {
    const raw = error as PostgrestErrorShape;
    const message = text(raw.message);
    const details = text(raw.details);
    const hint = text(raw.hint);
    const code = text(raw.code);

    // `details` and `hint` are where Postgres puts the specifics — omitting
    // them is how a precise refusal becomes a vague one.
    const parts = [message ?? fallbackMessage];
    if (details && details !== message) parts.push(details);
    if (hint && hint !== message && hint !== details) parts.push(hint);

    const normalized = new Error(parts.join("\n\n")) as AppError;
    if (code) normalized.code = code;
    if (details) normalized.details = details;
    if (hint) normalized.hint = hint;
    return normalized;
  }

  return new Error(text(error) ?? fallbackMessage) as AppError;
}
