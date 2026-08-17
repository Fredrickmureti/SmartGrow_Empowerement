/**
 * Phase 5.1 — desktop replay safety.
 *
 * The mobile RF surface routes every mutating RPC through
 * `wms_replay_guarded_call` (Phase 3.9) so a drained offline scan can never
 * apply twice. The desktop warehouse screens had no equivalent: a
 * double-clicked "Complete pick", a React-Query retry after a flaky
 * response, or an operator hammering "Record count" applied the quantity
 * mutation twice with two different natural keys, and nothing on the server
 * could tell them apart.
 *
 * This module is the single desktop chokepoint. It gives every logical
 * operator *intent* a stable `client_scan_id` and dispatches through the
 * same server-side ledger (`wms_client_scan_receipts`, advisory-locked,
 * UNIQUE (device_id, client_scan_id)).
 *
 * INTENT IDENTITY. A `client_scan_id` cannot be minted per call — that
 * would give a double-click two ids and defeat the ledger. Instead the id
 * is keyed on `(rpc, canonical args)` and reused for `INTENT_TTL_MS`. So:
 *
 *   - double-click / StrictMode double-fire / retried mutation → same id,
 *     the server short-circuits and returns the first outcome;
 *   - a genuinely repeated identical action later (recount the same bin to
 *     the same quantity an hour on) → new id, applies normally.
 *
 * Consumers: `useDomainOperations.ts` and the desktop warehouse pages. Do
 * not call `supabase.rpc("<mutating rpc>")` from `src/pages/warehouse/**`
 * directly — `wms-client-scan-id-unique.test.ts` fails the build if you do.
 */
import { supabase } from "@/integrations/supabase/client";
import { WmsRpcError } from "@/features/warehouse/errors/wmsRpcError";

const DEVICE_KEY = "wms_client_device_id";
/** Window in which an identical intent is treated as the same operator action. */
export const INTENT_TTL_MS = 30_000;

/** Stable per-device identifier, paired with client_scan_id for dedup. */
export function deviceId(): string {
  if (typeof localStorage === "undefined") return "device-ssr";
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `device-${crypto.randomUUID()}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** Deterministic serialisation so key order cannot fork the intent key. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${k}:${canonical(v)}`).join(",")}}`;
  }
  return String(value);
}

const intents = new Map<string, { id: string; at: number }>();

/** Resolve (and cache) the client_scan_id for one logical intent. */
export function intentId(rpc: string, args: Record<string, unknown>): string {
  const key = `${rpc}|${canonical(args)}`;
  const now = Date.now();
  for (const [k, v] of intents) {
    if (now - v.at > INTENT_TTL_MS) intents.delete(k);
  }
  const hit = intents.get(key);
  if (hit) return hit.id;
  const id = crypto.randomUUID();
  intents.set(key, { id, at: now });
  return id;
}

/** Drop a cached intent so the next identical call re-applies. Used after a
 *  business-logic rejection, where the operator is expected to fix inputs
 *  and legitimately resubmit the same values. */
export function forgetIntent(rpc: string, args: Record<string, unknown>): void {
  intents.delete(`${rpc}|${canonical(args)}`);
}

/** Test-only — clears the intent cache between cases. */
export function _resetIntents(): void {
  intents.clear();
}

export interface GuardedCallResult<T> {
  /** True when the server returned a previously recorded outcome. */
  replayed: boolean;
  data: T;
  client_scan_id: string;
}

/**
 * Execute a whitelisted WMS RPC through the replay dispatcher.
 * Rejections are re-thrown as `WmsRpcError` — a real `Error` that keeps the
 * Postgres `message`/`details`/`hint`/`code`, so callers can classify them
 * through `toWmsFailure` instead of stringifying a plain object.
 */
export async function replayGuardedCall<T = unknown>(
  rpc: string,
  args: Record<string, unknown>,
): Promise<GuardedCallResult<T>> {
  const clientScanId = intentId(rpc, args);
  const { data, error } = await supabase.rpc("wms_replay_guarded_call", {
    p_rpc: rpc,
    p_args: args as never,
    p_client_scan_id: clientScanId,
    p_device_id: deviceId(),
  });
  if (error) {
    // A rejected call recorded no receipt; let the operator retry the same
    // values once they have fixed whatever the server complained about.
    forgetIntent(rpc, args);
    throw new WmsRpcError(rpc, error);
  }
  const envelope = (data ?? {}) as { replayed?: boolean; result?: unknown };
  return {
    replayed: envelope.replayed === true,
    data: (envelope.result ?? null) as T,
    client_scan_id: clientScanId,
  };
}
