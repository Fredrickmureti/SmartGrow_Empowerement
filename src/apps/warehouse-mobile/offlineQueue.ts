/**
 * Warehouse mobile offline task queue (Phase 13 · hardened in Phase 3.9).
 *
 * Every mobile RPC call goes through `enqueue()`. When online, the call
 * fires immediately and the caller resolves with the result. When offline
 * (or on a network error), the call is persisted to IndexedDB and drained
 * later by the background drain loop.
 *
 * REPLAY SAFETY (Phase 3.9). Every call is stamped with a stable
 * `client_scan_id` (uuid) and a per-device `device_id`, and is executed
 * through the single server-side chokepoint
 * `wms_replay_guarded_call(p_rpc, p_args, p_client_scan_id, p_device_id)`.
 * The server dedups on `(device_id, client_scan_id)` in
 * `wms_client_scan_receipts` under an advisory lock, so a drain that
 * replays a queued call after a network drop can never apply a
 * quantity-mutating action twice (receive / pick / count / seal / load).
 * Do NOT re-introduce a bare `supabase.rpc(rpc, args)` path here — the
 * natural outbox idempotency keys are derived from rows the RPC *creates*
 * and therefore do not protect against replays.
 *
 * This module is the ONLY place `supabase.rpc` is called from within
 * `src/apps/warehouse-mobile/**` and `src/pages/warehouse-mobile/**` — the
 * phase-13 architecture guard enforces that. A single chokepoint means a
 * single retry policy and a single idempotency ledger.
 */
import { openDB, type IDBPDatabase } from "idb";
import { supabase } from "@/integrations/supabase/client";

export type QueueStatus = "synced" | "pending" | "error";

export interface QueuedCall {
  /** client_scan_id — the IndexedDB key and the server dedup key. */
  id: string;
  rpc: string;
  args: Record<string, unknown>;
  device_id: string;
  enqueued_at: number;
  attempts: number;
  last_error?: string | null;
}

const DB_NAME = "wm-offline-queue";
/** v2 store, keyed by client_scan_id. */
const STORE = "scans";
/** v1 store (autoincrement, no scan id). Drained once, then emptied. */
const LEGACY_STORE = "calls";
const DEVICE_KEY = "wms_client_device_id";

let dbP: Promise<IDBPDatabase> | null = null;

function db() {
  if (!dbP) {
    dbP = openDB(DB_NAME, 2, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: "id" });
        }
        // The legacy v1 store is intentionally left in place so queued
        // work on a driver's phone survives the upgrade; `carryOverLegacy`
        // moves those rows across on the next drain.
      },
    });
  }
  return dbP;
}

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

function newScanId(): string {
  return crypto.randomUUID();
}

const listeners = new Set<() => void>();
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) fn();
}

async function persist(row: QueuedCall) {
  const d = await db();
  await d.put(STORE, row);
  notify();
}

export async function pending(): Promise<QueuedCall[]> {
  const d = await db();
  return (await d.getAll(STORE)) as QueuedCall[];
}

export async function pendingCount(): Promise<number> {
  const d = await db();
  return d.count(STORE);
}

function isNetworkError(message: string | undefined): boolean {
  const msg = (message ?? "").toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("load failed") ||
    msg.includes("timeout")
  );
}

/**
 * Execute one call through the guarded dispatcher. Returns the unwrapped
 * business result; `replayed: true` responses resolve successfully with the
 * originally recorded outcome.
 */
async function execute(row: QueuedCall): Promise<unknown> {
  const { data, error } = await supabase.rpc("wms_replay_guarded_call", {
    p_rpc: row.rpc,
    p_args: row.args as never,
    p_client_scan_id: row.id,
    p_device_id: row.device_id,
  });
  if (error) throw error;
  const envelope = (data ?? {}) as { replayed?: boolean; result?: unknown };
  return envelope.result ?? null;
}

/**
 * Fire an RPC. If online, resolve with the RPC result. If offline or the
 * call fails with a network-shaped error, persist to IndexedDB and resolve
 * with `{ queued: true }`. Business-logic errors (RLS denials, validation)
 * always throw.
 */
export async function enqueue<T = unknown>(
  rpc: string,
  args: Record<string, unknown>,
): Promise<{ queued: boolean; data?: T; client_scan_id: string }> {
  const row: QueuedCall = {
    id: newScanId(),
    rpc,
    args,
    device_id: deviceId(),
    enqueued_at: Date.now(),
    attempts: 0,
    last_error: null,
  };

  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  if (online) {
    try {
      const data = await execute(row);
      // Phase 4 §4: one chokepoint emits operator feedback, so every /wm
      // screen beeps/buzzes/flashes identically without per-screen wiring.
      emitScanOutcome("success");
      return { queued: false, data: data as T, client_scan_id: row.id };
    } catch (err) {
      const message = (err as { message?: string })?.message;
      // Network-shape errors (fetch failure, offline mid-flight) → queue.
      // Server-side errors (RLS, validation) → throw so the UI surfaces it.
      if (!isNetworkError(message)) {
        emitScanOutcome("error");
        throw err;
      }
      await persist(row);
      // Queued, not committed — a distinct tone so the operator knows the
      // work is held rather than done.
      emitScanOutcome("warn");
      return { queued: true, client_scan_id: row.id };
    }
  }
  await persist(row);
  emitScanOutcome("warn");
  return { queued: true, client_scan_id: row.id };
}

/**
 * Move any v1 rows (enqueued before Phase 3.9) into the v2 store, stamping
 * them with a scan id. Their original submissions never reached the server
 * — they were persisted precisely because the network was down — so a fresh
 * id is correct here.
 */
async function carryOverLegacy(): Promise<void> {
  const d = await db();
  if (!d.objectStoreNames.contains(LEGACY_STORE)) return;
  const legacy = (await d.getAll(LEGACY_STORE)) as Array<{
    id?: number;
    rpc: string;
    args: Record<string, unknown>;
    enqueued_at?: number;
    attempts?: number;
    last_error?: string | null;
  }>;
  if (legacy.length === 0) return;
  for (const old of legacy) {
    await d.put(STORE, {
      id: newScanId(),
      rpc: old.rpc,
      args: old.args ?? {},
      device_id: deviceId(),
      enqueued_at: old.enqueued_at ?? Date.now(),
      attempts: old.attempts ?? 0,
      last_error: old.last_error ?? null,
    } satisfies QueuedCall);
    if (old.id != null) await d.delete(LEGACY_STORE, old.id);
  }
  notify();
}

let draining = false;
export async function drainOnce(): Promise<{ drained: number; failed: number }> {
  if (draining) return { drained: 0, failed: 0 };
  draining = true;
  let drained = 0;
  let failed = 0;
  try {
    await carryOverLegacy();
    const d = await db();
    const rows = (await d.getAll(STORE)) as QueuedCall[];
    // FIFO, stop-on-first-network-failure so scan ordering is preserved.
    rows.sort((a, b) => a.enqueued_at - b.enqueued_at);
    for (const row of rows) {
      try {
        await execute(row);
        await d.delete(STORE, row.id);
        drained++;
      } catch (err) {
        const message = (err as { message?: string })?.message;
        if (isNetworkError(message)) {
          // Stop the drain — we'll try again on the next tick.
          break;
        }
        // Non-network error: bump attempts, stamp error, keep in queue for
        // manual retry. The UI drawer surfaces these.
        await d.put(STORE, {
          ...row,
          attempts: (row.attempts ?? 0) + 1,
          last_error: message ?? "unknown error",
        } satisfies QueuedCall);
        failed++;
      }
    }
  } finally {
    draining = false;
    if (drained > 0 || failed > 0) notify();
  }
  return { drained, failed };
}

export async function retry(id: string) {
  const d = await db();
  const row = (await d.get(STORE, id)) as QueuedCall | undefined;
  if (!row) return;
  try {
    await execute(row);
    await d.delete(STORE, id);
  } catch (err) {
    await d.put(STORE, {
      ...row,
      attempts: (row.attempts ?? 0) + 1,
      last_error: (err as { message?: string })?.message ?? "unknown error",
    } satisfies QueuedCall);
  }
  notify();
}

export async function discard(id: string) {
  const d = await db();
  await d.delete(STORE, id);
  notify();
}

let started = false;
export function startDrainLoop() {
  if (started || typeof window === "undefined") return;
  started = true;
  const tick = () => {
    void drainOnce();
  };
  window.addEventListener("online", tick);
  window.setInterval(tick, 8000);
  // Kick once on startup.
  tick();
}
