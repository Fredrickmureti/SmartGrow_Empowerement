/**
 * One place that turns a lending refusal into a sentence an operator can act on.
 *
 * The lending guards are database triggers and RPCs that `RAISE EXCEPTION` with
 * a deliberate business sentence ("An application cannot be decided before an
 * assessment is recorded"). Those refusals arrive from supabase-js as PLAIN
 * OBJECTS — `{ message, details, hint, code }` — not `Error` instances, so the
 * old `error instanceof Error ? error.message : String(error)` idiom rendered
 * `[object Object]` and destroyed every business reason in the workflow.
 *
 * Rules:
 *  - a deliberate business refusal (SQLSTATE P0001) keeps its own wording;
 *  - infrastructure failures fall back to the shared `normalizeError` catalogue
 *    (offline, session expired, server unavailable, …);
 *  - raw SQL, constraint names, relation names and stack text never reach the UI.
 */
import { normalizeError } from "@/services/resilience";

interface PgLike {
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  code?: unknown;
}

function asPg(error: unknown): PgLike {
  if (error && typeof error === "object") return error as PgLike;
  return {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Raw refusal text from either shape, for pattern matching only. */
export function rawErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const e = asPg(error);
  const parts = [text(e.message), text(e.details), text(e.hint)].filter(Boolean);
  if (parts.length) return parts.join(" — ");
  return typeof error === "string" ? error : "";
}

function errorCode(error: unknown): string {
  return text(asPg(error).code);
}

/** True when the text looks like database internals rather than a business sentence. */
function looksTechnical(msg: string): boolean {
  return (
    /SQLSTATE|PL\/pgSQL|relation "|column "|function .*\(.*\) does not exist|syntax error|invalid input syntax|at character \d|constraint "/i.test(
      msg,
    ) || /_chk\b|_uniq\b|_fkey\b|_pkey\b/i.test(msg)
  );
}

/**
 * The message to show the user for a lending refusal.
 *
 * @param error    the thrown value (PostgrestError, RPC error, Error, string)
 * @param fallback what to say when nothing meaningful can be extracted
 */
export function lendingErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  const raw = rawErrorText(error);

  // Permission and scope refusals — never echo the policy or table name.
  if (code === "42501" || /row-level security|permission denied/i.test(raw)) {
    return "You do not have permission to perform this action.";
  }

  // Deliberate business refusals raised by the lending guards.
  if (code === "P0001" || (!code && raw && !looksTechnical(raw))) {
    const sentence = text(asPg(error).message) || raw;
    if (sentence && !looksTechnical(sentence)) {
      let out = sentence.replace(/^ERROR:\s*/i, "");
      if (/closed|locked/i.test(out) && /period/i.test(out)) {
        out += " Reopen the accounting month, or use a date inside an open month.";
      }
      return out;
    }
  }

  // Structural refusals: say what happened in business terms.
  if (code === "23505" || /duplicate key|already exists/i.test(raw)) {
    return "That record already exists.";
  }
  if (code === "23514") {
    return "Some of the values entered are outside what this record allows. Review them and try again.";
  }
  if (code === "23503") {
    return "This record is linked to others and cannot be changed that way.";
  }

  // Anything left is infrastructure — use the shared catalogue.
  const normalized = normalizeError(error);
  if (normalized.kind !== "unknown") return normalized.message;
  return fallback;
}
