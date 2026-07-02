/**
 * supabaseSafe
 *
 * Thin wrapper around Supabase query/RPC calls that drives the
 * ConnectivityManager state machine and produces NormalizedError
 * results so callers never need to touch raw `error.message`.
 *
 * Usage:
 *   const { data, error } = await safeQuery(
 *     supabase.from("invoices").select("*").eq("organization_id", orgId)
 *   );
 *   if (error) { toast.error(error.title, { description: error.message }); return; }
 *
 * The helper is intentionally NOT a fetch interceptor — Supabase-js
 * uses its own internal client and we don't want to hijack that. Call
 * sites opt in explicitly.
 */

import { connectivityManager } from "./ConnectivityManager";
import { normalizeError, type NormalizedError } from "./ErrorNormalizer";

export interface SafeResult<T> {
  data: T | null;
  error: NormalizedError | null;
}

type SupabaseLikeResult<T> = { data: T | null; error: unknown };

export interface SafeQueryOptions {
  /** Hard ceiling in ms before we abort the request and normalize to `timeout`. Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Wrap any thenable that resolves to a `{ data, error }` Supabase envelope.
 * Short-circuits with `kind: 'offline'` when the manager already knows
 * we're offline so we don't pile up doomed requests. Races against a
 * timeout so hung TCP connections (captive portals, WiFi-without-internet)
 * surface as `kind: 'timeout'` instead of spinning forever.
 */
export async function safeQuery<T>(
  builder: PromiseLike<SupabaseLikeResult<T>>,
  opts: SafeQueryOptions = {},
): Promise<SafeResult<T>> {
  if (connectivityManager.getStatus() === "offline") {
    return { data: null, error: normalizeError(new TypeError("Failed to fetch"), { connectivity: "offline" }) };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error("Request timed out");
        (e as Error & { name: string }).name = "TimeoutError";
        reject(e);
      }, timeoutMs);
    });
    try {
      const { data, error } = await Promise.race([builder, timeout]) as SupabaseLikeResult<T>;
      if (error) {
        const normalized = normalizeError(error, { connectivity: connectivityManager.getStatus() });
        // 4xx/5xx prove the server is reachable — keep status online unless
        // the failure was specifically a transport-level one.
        if (normalized.kind === "offline") connectivityManager.reportFailure();
        else connectivityManager.reportSuccess();
        return { data: null, error: normalized };
      }
      connectivityManager.reportSuccess();
      return { data: data ?? null, error: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (thrown) {
    const normalized = normalizeError(thrown, { connectivity: connectivityManager.getStatus() });
    if (normalized.kind === "offline" || normalized.kind === "timeout") connectivityManager.reportFailure();
    return { data: null, error: normalized };
  }
}

/**
 * Same as `safeQuery` but explicitly for `.rpc()` calls; the shape is
 * identical so this is sugar for readability at call sites.
 */
export const safeRpc = safeQuery;

export interface RetryOptions extends SafeQueryOptions {
  /** Maximum retry attempts after the initial call. Default 2 (total 3 tries). */
  maxRetries?: number;
  /** Base backoff in ms; each retry is `base * 2^attempt` + jitter. Default 400. */
  baseDelayMs?: number;
}

const RETRYABLE_KINDS = new Set(["offline", "timeout", "server_unavailable"]);

/**
 * `safeQuery` with bounded exponential-backoff retry. Retries only for
 * `offline`, `timeout`, and `server_unavailable` — never for auth or
 * permission failures (those are deterministic and would spam).
 *
 * Builders must be re-runnable; pass a factory rather than a pre-built
 * thenable so each attempt issues a fresh request.
 */
export async function safeQueryRetry<T>(
  factory: () => PromiseLike<SupabaseLikeResult<T>>,
  opts: RetryOptions = {},
): Promise<SafeResult<T>> {
  const max = opts.maxRetries ?? 2;
  const base = opts.baseDelayMs ?? 400;
  let last: SafeResult<T> = { data: null, error: null };
  for (let attempt = 0; attempt <= max; attempt++) {
    last = await safeQuery(factory(), opts);
    if (!last.error) return last;
    if (!RETRYABLE_KINDS.has(last.error.kind)) return last;
    if (attempt === max) return last;
    const jitter = Math.random() * 200;
    await new Promise((r) => setTimeout(r, base * Math.pow(2, attempt) + jitter));
  }
  return last;
}
