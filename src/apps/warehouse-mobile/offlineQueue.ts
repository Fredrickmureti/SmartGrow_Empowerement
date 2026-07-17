/**
 * Warehouse mobile offline task queue (Phase 13).
 *
 * Every mobile RPC call goes through `enqueue()`. When online, the RPC
 * fires immediately and the caller resolves with the result. When offline
 * (or on a network error), the call is persisted to IndexedDB and drained
 * later by the background drain loop.
 *
 * All WMS RPCs already carry natural idempotency keys of the shape
 * `wms.<entity>:<id>:<state>` on the server-side outbox, so replaying a
 * queued call is safe — the server will deduplicate.
 *
 * This module is the ONLY place `supabase.rpc` is called from within
 * `src/apps/warehouse-mobile/**` — the phase-13 architecture guard enforces
 * that. A single chokepoint means a single retry policy.
 */
import { openDB, type IDBPDatabase } from "idb";
import { supabase } from "@/integrations/supabase/client";

export type QueueStatus = "synced" | "pending" | "error";

export interface QueuedCall {
  id?: number;
  rpc: string;
  args: Record<string, unknown>;
  enqueued_at: number;
  attempts: number;
  last_error?: string | null;
}

const DB_NAME = "wm-offline-queue";
const STORE = "calls";
let dbP: Promise<IDBPDatabase> | null = null;

function db() {
  if (!dbP) {
    dbP = openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        }
      },
    });
  }
  return dbP;
}

const listeners = new Set<() => void>();
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) fn();
}

async function persist(rpc: string, args: Record<string, unknown>) {
  const d = await db();
  await d.add(STORE, {
    rpc,
    args,
    enqueued_at: Date.now(),
    attempts: 0,
    last_error: null,
  } satisfies QueuedCall);
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

/**
 * Fire an RPC. If online, resolve with the RPC result. If offline or the
 * call fails with a network-shaped error, persist to IndexedDB and resolve
 * with `{ queued: true }`. Business-logic errors (RLS denials, validation)
 * always throw.
 */
export async function enqueue<T = unknown>(
  rpc: string,
  args: Record<string, unknown>,
): Promise<{ queued: boolean; data?: T }> {
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  if (online) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.rpc as any)(rpc, args);
    if (!error) return { queued: false, data: data as T };
    // Network-shape errors (fetch failure, offline mid-flight) → queue.
    // Server-side errors (RLS, validation) → throw so the UI surfaces it.
    const msg = (error.message ?? "").toLowerCase();
    const networky =
      msg.includes("failed to fetch") ||
      msg.includes("networkerror") ||
      msg.includes("load failed") ||
      msg.includes("timeout");
    if (!networky) throw error;
    await persist(rpc, args);
    return { queued: true };
  }
  await persist(rpc, args);
  return { queued: true };
}

let draining = false;
export async function drainOnce(): Promise<{ drained: number; failed: number }> {
  if (draining) return { drained: 0, failed: 0 };
  draining = true;
  let drained = 0;
  let failed = 0;
  try {
    const d = await db();
    const rows = (await d.getAll(STORE)) as QueuedCall[];
    for (const row of rows) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.rpc as any)(row.rpc, row.args);
      if (!error) {
        await d.delete(STORE, row.id!);
        drained++;
        continue;
      }
      const msg = (error.message ?? "").toLowerCase();
      const networky =
        msg.includes("failed to fetch") ||
        msg.includes("networkerror") ||
        msg.includes("load failed") ||
        msg.includes("timeout");
      if (networky) {
        // Stop the drain — we'll try again on the next tick.
        break;
      }
      // Non-network error: bump attempts, stamp error, keep in queue for
      // manual retry. The UI drawer surfaces these.
      const updated: QueuedCall = {
        ...row,
        attempts: (row.attempts ?? 0) + 1,
        last_error: error.message ?? "unknown error",
      };
      await d.put(STORE, updated);
      failed++;
    }
  } finally {
    draining = false;
    if (drained > 0 || failed > 0) notify();
  }
  return { drained, failed };
}

export async function retry(id: number) {
  const d = await db();
  const row = (await d.get(STORE, id)) as QueuedCall | undefined;
  if (!row) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.rpc as any)(row.rpc, row.args);
  if (!error) {
    await d.delete(STORE, id);
  } else {
    await d.put(STORE, {
      ...row,
      attempts: (row.attempts ?? 0) + 1,
      last_error: error.message ?? "unknown error",
    });
  }
  notify();
}

export async function discard(id: number) {
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
