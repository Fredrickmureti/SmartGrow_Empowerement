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
  ],
  wms_loading_manifests: [
    ["wms-loading-manifests"],
    ["wms-loading-manifest"],
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

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryClientRef = useRef(queryClient);
  const orgIdRef = useRef<string | undefined>(currentOrg?.id);
  const businessIdRef = useRef<string | null | undefined>(currentBusiness?.id);

  useEffect(() => { queryClientRef.current = queryClient; }, [queryClient]);
  useEffect(() => { orgIdRef.current = currentOrg?.id; }, [currentOrg?.id]);
  useEffect(() => { businessIdRef.current = currentBusiness?.id; }, [currentBusiness?.id]);

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
}

export default useWmsRealtimeSync;
