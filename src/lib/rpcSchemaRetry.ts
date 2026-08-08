/**
 * PostgREST answers `404 / PGRST202` when it is asked for a function that
 * exists in the database but is not yet in the API layer's schema cache —
 * the window right after a function is created or replaced.
 *
 * That is a cold-cache condition, not a missing feature, and it resolves on
 * its own within a second. Retrying once turns a confusing "not found" toast
 * into a successful action.
 */
const SCHEMA_CACHE_MISS = "PGRST202";

interface RpcError {
  code?: string | null;
  message?: string | null;
}

export function isSchemaCacheMiss(error: RpcError | null | undefined): boolean {
  if (!error) return false;
  if (error.code === SCHEMA_CACHE_MISS) return true;
  const msg = error.message ?? "";
  return /schema cache/i.test(msg) && /function/i.test(msg);
}

/**
 * Runs an RPC call, retrying once if the API layer has not caught up with the
 * database yet. Every other error is returned untouched.
 */
export async function callRpcWithSchemaRetry<T extends { error: RpcError | null }>(
  invoke: () => Promise<T>,
  delayMs = 750,
): Promise<T> {
  const first = await invoke();
  if (!isSchemaCacheMiss(first.error)) return first;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return invoke();
}
