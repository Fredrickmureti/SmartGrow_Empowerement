/**
 * WMS Realtime Sync — Phase 2.3 (ADR 0079, ADR 0101).
 *
 * Subscribes to every warehouse-execution table that broadcasts on the
 * supabase_realtime publication and invalidates the corresponding
 * React Query keys used by the WMS pages. Mount ONCE inside
 * `WarehouseLayout` so it runs only when the operator is actually in the
 * warehouse app — non-warehouse users don't need the extra channel.
 *
 * Architectural rules (unified with useUnifiedRealtimeSync):
 * - Single channel per organization ("org-<id>-wms").
 * - Handler + invalidator are stable (empty deps); latest org / business
 *   values are read from refs so business switches don't tear the
 *   channel down.
 * - refetchType: 'active' — no refetch of unmounted queries.
 * - Exponential backoff reconnect with a full re-invalidation sweep on
 *   reconnect to catch missed events.
 * - Cleanup via supabase.removeChannel().
 */
import { useEffect, useRef, useCallback, useContext } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { BusinessContext } from "@/contexts/BusinessContext";
import { connectivityManager } from "@/services/resilience/ConnectivityManager";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";

type PostgresPayload = {
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  eventType: string;
  schema: string;
  table: string;
  commit_timestamp: string;
  errors: unknown;
};

/**
 * Tables → the React Query key prefixes that WMS pages register their
 * queries under. When any row on a subscribed table changes we invalidate
 * every key prefix listed here for that table.
 */
const TABLE_INVALIDATIONS: Record<string, ReadonlyArray<readonly unknown[]>> = {
  wms_tasks: [
    ["wms_tasks"],
    ["wms-tasks-loc-options"],
    // ADR 0086 Phase 5 — jockey work orders live on the yard surfaces.
    ["wms-yard-move-tasks"],
  ],
  wms_license_plates: [
    ["wms-lpns"],
    ["wms-lpn"],
  ],
  wms_exceptions: [
    ["wms_exceptions"],
  ],
  wms_receiving_sessions: [
    ["wms-receiving-sessions"],
    // ADR 0086 Phase 7 — receiving progress drives yard load readiness.
    ["wms-trailer-load-summary"],
  ],
  wms_return_orders: [
    ["wms-return-orders"],
  ],
  wms_pick_waves: [
    ["wms-pick-waves"],
    ["wms-pick-wave"],
  ],
  wms_pack_cartons: [
    ["wms-pack-cartons"],
    ["wms-pack-wave"],
  ],
  wms_manifest_cartons: [
    ["wms-loading-manifest"],
    ["wms-loading-manifests"],
    ["wms-manifest-cartons"],
    ["wms-manifest-shortage"],
  ],
  wms_loading_manifests: [
    ["wms-loading-manifests"],
    ["wms-loading-manifest"],
    // Phase F — the Loading Bay registers its detail queries under
    // `wms-manifest*`, not `wms-loading-manifest`. That drift is why the
    // bay was still polling; both prefixes are invalidated now.
    ["wms-manifest"],
    ["wms-manifest-cartons"],
    ["wms-manifest-shortage"],
    ["wms-manifest-proof"],
  ],
  wms_qc_inspections: [
    ["wms-qc-inspections"],
    ["wms-qc-inspection"],
  ],
  wms_count_sessions: [
    ["wms-count-sessions"],
    ["wms-count-session"],
  ],
  wms_count_lines: [
    ["wms-count-session"],
    ["wms-count-lines"],
  ],
  // Phase 4 §6 — the Inbound control tower tiles appointment state.
  wms_dock_appointments: [
    ["wms-dock-appointments"],
    ["wms-dock-appointment"],
  ],
  // ADR 0108 — replenishment control centre replaces its 15s poll.
  wms_replen_orders: [
    ["wms-replen-orders"],
    ["wms-replen-tasks"],
  ],
  wms_replenishment_rules: [
    ["wms-replen-rules"],
  ],
  // Phase F — the yard boards go live; both surfaces polled every 15s.
  wms_trailer_visits: [
    ["wms-trailer-visits"],
    ["wms-loading-manifests"],
    ["dock-live-visits"],
    ["wms-departure-blockers"],
    // `wms_gate_events` is not published; gate custody is refetched
    // whenever the visit it belongs to changes.
    ["wms-gate-events"],
  ],
  wms_yard_slots: [
    ["wms-yard-slots"],
  ],
  // Yard control tower (ADR 0086) — trailer master + physical move ledger.
  wms_trailers: [
    ["wms-trailers"],
  ],
  wms_yard_moves: [
    ["wms-yard-moves"],
    ["wms-trailer-visits"],
  ],
};

/** Public list of subscribed tables — exported so the guard test can
 * pin this set against the DB publication membership. */
export const WMS_REALTIME_TABLES = Object.keys(TABLE_INVALIDATIONS);

const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;

function invalidateForTable(
  qc: QueryClient,
  table: string,
): void {
  const keys = TABLE_INVALIDATIONS[table];
  if (!keys) return;
  for (const key of keys) {
    qc.invalidateQueries({
      queryKey: key as unknown[],
      refetchType: "active",
    });
  }
}

function invalidateAllWmsKeys(qc: QueryClient): void {
  const seen = new Set<string>();
  for (const table of Object.keys(TABLE_INVALIDATIONS)) {
    for (const key of TABLE_INVALIDATIONS[table]) {
      const sig = JSON.stringify(key);
      if (seen.has(sig)) continue;
      seen.add(sig);
      qc.invalidateQueries({
        queryKey: key as unknown[],
        refetchType: "active",
      });
    }
  }
}

export function useWmsRealtimeSync(): void {
  const queryClient = useQueryClient();
  const { currentOrg } = useOrganization();
  const businessCtx = useContext(BusinessContext);
  const currentBusiness = businessCtx?.currentBusiness ?? null;
  const { user } = useAuth();

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryClientRef = useRef(queryClient);
  const orgIdRef = useRef<string | undefined>(currentOrg?.id);
  const businessIdRef = useRef<string | null | undefined>(currentBusiness?.id);
  const userIdRef = useRef<string | undefined>(user?.id);
  const seenAssignRef = useRef<Set<string>>(new Set());
  const seenContentionRef = useRef<Set<string>>(new Set());

  /**
   * Phase 4 §3 — multi-operator contention.
   *
   * Two pickers can reach for the same task. The loser's screen would
   * otherwise keep showing the task as theirs until the next refetch, and
   * they'd walk the aisle for nothing. When a task that WAS claimed by (or
   * assigned to) me flips to somebody else, say so immediately.
   */
  const detectContention = useCallback((payload: PostgresPayload) => {
    if (payload.table !== "wms_tasks") return;
    const uid = userIdRef.current;
    if (!uid) return;
    const before = payload.old as
      | { id?: string; claimed_by?: string | null; assignee_user_id?: string | null }
      | null;
    const after = payload.new as
      | {
          id?: string;
          claimed_by?: string | null;
          assignee_user_id?: string | null;
          task_type?: string | null;
          state?: string | null;
        }
      | null;
    if (!after?.id) return;

    const wasMine =
      before?.claimed_by === uid || before?.assignee_user_id === uid;
    const nowTheirs =
      (after.claimed_by != null && after.claimed_by !== uid) ||
      (after.assignee_user_id != null && after.assignee_user_id !== uid);
    if (!wasMine || !nowTheirs) return;

    // Realtime can redeliver; one warning per (task, new owner) is enough.
    const key = `${after.id}:${after.claimed_by ?? after.assignee_user_id}`;
    if (seenContentionRef.current.has(key)) return;
    seenContentionRef.current.add(key);
    if (seenContentionRef.current.size > 200) {
      seenContentionRef.current = new Set(
        Array.from(seenContentionRef.current).slice(-100),
      );
    }

    toast({
      variant: "destructive",
      title: "Task taken by another operator",
      description: `${(after.task_type ?? "task").toUpperCase()} · it left your queue — pull the next task.`,
    });
  }, []);

  useEffect(() => { queryClientRef.current = queryClient; }, [queryClient]);
  useEffect(() => { orgIdRef.current = currentOrg?.id; }, [currentOrg?.id]);
  useEffect(() => { businessIdRef.current = currentBusiness?.id; }, [currentBusiness?.id]);
  useEffect(() => { userIdRef.current = user?.id; }, [user?.id]);

  const handleChange = useCallback((payload: PostgresPayload) => {
    const orgId = orgIdRef.current;
    if (!orgId) return;
    if (import.meta.env.DEV) {
      const row = (payload.new ?? payload.old) as { id?: unknown } | null;
      // eslint-disable-next-line no-console
      console.debug(
        `[WmsRealtime] ${payload.table} ${payload.eventType}:`,
        row && "id" in row ? row.id : "unknown",
      );
    }
    invalidateForTable(queryClientRef.current, payload.table);
    detectContention(payload);
  }, []);

  useEffect(() => {
    const orgId = currentOrg?.id;
    if (!orgId) return;

    let cancelled = false;
    reconnectAttemptRef.current = 0;

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectAttemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
        // eslint-disable-next-line no-console
        console.error(
          `[WmsRealtime] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached.`,
        );
        return;
      }
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      const delay = Math.min(
        RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttemptRef.current),
        RECONNECT_MAX_DELAY,
      );
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        if (!cancelled) openChannel();
      }, delay);
    };

    const openChannel = () => {
      if (cancelled) return;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      const channel = supabase.channel(`org-${orgId}-wms`, {
        config: { broadcast: { self: false } },
      });

      for (const table of WMS_REALTIME_TABLES) {
        channel.on(
          "postgres_changes" as never,
          {
            event: "*",
            schema: "public",
            table,
            filter: `organization_id=eq.${orgId}`,
          },
          handleChange,
        );
      }

      channel.subscribe((status: string) => {
        if (cancelled) return;
        if (status === "SUBSCRIBED") {
          connectivityManager.reportRealtimeState("subscribed");
          if (reconnectAttemptRef.current > 0) {
            invalidateAllWmsKeys(queryClientRef.current);
          }
          reconnectAttemptRef.current = 0;
        } else if (
          status === "CLOSED" ||
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT"
        ) {
          connectivityManager.reportRealtimeState(
            status === "CLOSED"
              ? "closed"
              : status === "CHANNEL_ERROR"
                ? "channel_error"
                : "timed_out",
          );
          scheduleReconnect();
        }
      });

      channelRef.current = channel;
    };

    openChannel();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id]);

  // ---------------------------------------------------------------------
  // Phase 3.6 — per-operator task fan-out.
  // A dedicated channel scoped to the currently authenticated user
  // listens for `wms_tasks` rows where `assignee_user_id = me`. When a
  // new assignment lands we pop a toast on the operator device so the
  // headset/RF user sees the "next task" instantly without a poll.
  // Kept on its own channel so a business switch never tears it down.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const uid = user?.id;
    if (!uid) return;
    const channel = supabase.channel(`user-${uid}-wms-tasks`);
    channel.on(
      "postgres_changes" as never,
      {
        event: "*",
        schema: "public",
        table: "wms_tasks",
        filter: `assignee_user_id=eq.${uid}`,
      },
      (payload: PostgresPayload) => {
        const row = (payload.new ?? payload.old) as
          | { id?: string; state?: string; task_type?: string; assignee_user_id?: string }
          | null;
        if (!row?.id) return;
        invalidateForTable(queryClientRef.current, "wms_tasks");
        // Only surface a notification on the leading edge of `assigned`.
        const key = `${row.id}:${row.state ?? ""}`;
        if (row.state !== "assigned") return;
        if (row.assignee_user_id !== userIdRef.current) return;
        if (seenAssignRef.current.has(key)) return;
        seenAssignRef.current.add(key);
        if (seenAssignRef.current.size > 200) {
          seenAssignRef.current = new Set(
            Array.from(seenAssignRef.current).slice(-100),
          );
        }
        toast({
          title: "New warehouse task assigned",
          description: `${(row.task_type ?? "task").toUpperCase()} · tap Next Task to start`,
        });
      },
    );
    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);
}

export default useWmsRealtimeSync;
