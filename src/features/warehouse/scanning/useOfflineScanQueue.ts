/**
 * Phase 3.8 — Offline scan queue with replay-safe dequeue.
 *
 * Persists mobile scan intents to IndexedDB so the RF client can keep
 * working while offline. Every enqueued scan is stamped with a stable
 * `client_scan_id` (UUID v4) and the device's identifier so that the
 * server-side `wms_client_scan_receipts` ledger dedupes duplicate
 * submissions arising from network retries, background sync, or app
 * reload.
 *
 * Contract:
 *   - `enqueue()` writes to IDB immediately and returns the assigned
 *     `client_scan_id`. The caller renders success feedback locally.
 *   - `drain()` walks the queue in insertion order, calls the matching
 *     RPC once per entry, and removes the entry from IDB when the
 *     server acknowledges (idempotent — a `replayed: true` acknowledgement
 *     counts as success and clears the entry).
 *   - The hook auto-drains on `online` events and on interval, so callers
 *     never observe the queue directly.
 *
 * Phase 13 mobile guard: this module is the one sanctioned bridge
 * between the RF shell and Supabase RPCs. It calls `supabase.rpc()`
 * ONLY from the shared drain worker — screens must go through
 * `enqueue()` and never reach for `supabase` directly.
 */
import { openDB, type IDBPDatabase } from "idb";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const DB_NAME = "wms_offline_scans";
const DB_VERSION = 1;
const STORE = "queue";
const DEVICE_KEY = "wms_client_device_id";

export type OfflineScanKind = "receiving_line" | "pick_completion";

export interface ReceivingLineArgs {
  session_id: string;
  product_id: string;
  received_qty: number;
  expected_qty?: number | null;
  lpn_id?: string | null;
  lot_number?: string | null;
  serial_number?: string | null;
  uom?: string | null;
  staging_location_id?: string | null;
  notes?: string | null;
}

export interface PickCompletionArgs {
  task_id: string;
  picked_qty: number;
  lpn_id?: string | null;
}

export type OfflineScanEntry =
  | {
      client_scan_id: string;
      queued_at: number;
      kind: "receiving_line";
      args: ReceivingLineArgs;
    }
  | {
      client_scan_id: string;
      queued_at: number;
      kind: "pick_completion";
      args: PickCompletionArgs;
    };

function getDeviceId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = window.localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `device-${crypto.randomUUID()}`;
    window.localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

async function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "client_scan_id" });
      }
    },
  });
}

async function putEntry(entry: OfflineScanEntry): Promise<void> {
  const database = await db();
  await database.put(STORE, entry);
}

async function listEntries(): Promise<OfflineScanEntry[]> {
  const database = await db();
  const rows = (await database.getAll(STORE)) as OfflineScanEntry[];
  return rows.sort((a, b) => a.queued_at - b.queued_at);
}

async function deleteEntry(clientScanId: string): Promise<void> {
  const database = await db();
  await database.delete(STORE, clientScanId);
}

async function submitEntry(
  entry: OfflineScanEntry,
  deviceId: string,
): Promise<{ ok: boolean; replayed?: boolean; error?: string }> {
  if (entry.kind === "receiving_line") {
    const { data, error } = await supabase.rpc("wms_capture_receiving_line", {
      p_session_id: entry.args.session_id,
      p_product_id: entry.args.product_id,
      p_received_qty: entry.args.received_qty,
      p_expected_qty: entry.args.expected_qty ?? null,
      p_lpn_id: entry.args.lpn_id ?? null,
      p_lot_number: entry.args.lot_number ?? null,
      p_serial_number: entry.args.serial_number ?? null,
      p_uom: entry.args.uom ?? null,
      p_staging_location_id: entry.args.staging_location_id ?? null,
      p_notes: entry.args.notes ?? null,
      p_client_scan_id: entry.client_scan_id,
      p_device_id: deviceId,
    } as never);
    if (error) return { ok: false, error: error.message };
    const replayed = Boolean((data as { replayed?: boolean } | null)?.replayed);
    return { ok: true, replayed };
  }
  const { data, error } = await supabase.rpc("wms_complete_pick_scan", {
    p_task_id: entry.args.task_id,
    p_picked_qty: entry.args.picked_qty,
    p_lpn_id: entry.args.lpn_id ?? null,
    p_client_scan_id: entry.client_scan_id,
    p_device_id: deviceId,
  } as never);
  if (error) return { ok: false, error: error.message };
  const replayed = Boolean((data as { replayed?: boolean } | null)?.replayed);
  return { ok: true, replayed };
}

export interface UseOfflineScanQueue {
  deviceId: string;
  pending: number;
  online: boolean;
  enqueueReceivingLine: (args: ReceivingLineArgs) => Promise<string>;
  enqueuePickCompletion: (args: PickCompletionArgs) => Promise<string>;
  drain: () => Promise<{ submitted: number; failed: number }>;
}

/**
 * Hook — persistent offline scan queue for the RF shell.
 *
 * Auto-drains every 5s and on `online` events. Manual `drain()` is
 * exposed for tests and for the sync-now UX affordance.
 */
export function useOfflineScanQueue(): UseOfflineScanQueue {
  const deviceId = useMemo(() => getDeviceId(), []);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const draining = useRef(false);

  const refreshPending = async () => {
    const rows = await listEntries();
    setPending(rows.length);
  };

  const drain = async (): Promise<{ submitted: number; failed: number }> => {
    if (draining.current) return { submitted: 0, failed: 0 };
    draining.current = true;
    let submitted = 0;
    let failed = 0;
    try {
      const rows = await listEntries();
      for (const entry of rows) {
        const result = await submitEntry(entry, deviceId);
        if (result.ok) {
          await deleteEntry(entry.client_scan_id);
          submitted += 1;
        } else {
          failed += 1;
          // Stop on first failure so ordering is preserved.
          break;
        }
      }
    } finally {
      draining.current = false;
      await refreshPending();
    }
    return { submitted, failed };
  };

  const enqueueReceivingLine = async (args: ReceivingLineArgs) => {
    const client_scan_id = crypto.randomUUID();
    await putEntry({ client_scan_id, queued_at: Date.now(), kind: "receiving_line", args });
    await refreshPending();
    if (typeof navigator === "undefined" || navigator.onLine) void drain();
    return client_scan_id;
  };

  const enqueuePickCompletion = async (args: PickCompletionArgs) => {
    const client_scan_id = crypto.randomUUID();
    await putEntry({ client_scan_id, queued_at: Date.now(), kind: "pick_completion", args });
    await refreshPending();
    if (typeof navigator === "undefined" || navigator.onLine) void drain();
    return client_scan_id;
  };

  useEffect(() => {
    void refreshPending();
    if (typeof window === "undefined") return;
    const onOnline = () => {
      setOnline(true);
      void drain();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const interval = window.setInterval(() => {
      if (navigator.onLine) void drain();
    }, 5000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { deviceId, pending, online, enqueueReceivingLine, enqueuePickCompletion, drain };
}
