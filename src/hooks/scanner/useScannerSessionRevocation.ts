/**
 * useScannerSessionRevocation — Plan P3 (phone-side proactive signal).
 *
 * Today the phone only learns its session is revoked when the desk sends
 * an explicit `SCAN_EVENTS.revoke` broadcast. If the desk has already
 * closed the tab — or the row was revoked out of band (admin tooling,
 * security timeout, organization switch) — the phone keeps trying to
 * broadcast scans against a dead channel and only discovers the failure
 * on `CHANNEL_ERROR`.
 *
 * This hook closes that gap: it subscribes the phone directly to its own
 * `scanner_sessions` row and fires `onRevoked` the moment `revoked_at`
 * transitions from NULL → non-NULL. It is purely additive — the existing
 * broadcast-driven revoke path stays in place as the primary signal; this
 * is the safety net.
 *
 * Caller is expected to flip its own status to `revoked` inside `onRevoked`
 * (stop camera, drop pending queue, surface the "session ended" screen).
 */

import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Args {
  sessionId: string | null | undefined;
  onRevoked: (reason: "row_update") => void;
}

export function useScannerSessionRevocation({ sessionId, onRevoked }: Args): void {
  const cbRef = useRef(onRevoked);
  cbRef.current = onRevoked;

  useEffect(() => {
    if (!sessionId) return;
    let firedFor: string | null = null;
    const ch = supabase
      .channel(`scanner_session_revoke:${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "scanner_sessions",
          filter: `id=eq.${sessionId}`,
        },
        (payload) => {
          const next = (payload.new as { revoked_at?: string | null } | null)?.revoked_at ?? null;
          const prev = (payload.old as { revoked_at?: string | null } | null)?.revoked_at ?? null;
          // Only fire on the NULL → non-NULL transition, and at most once per session.
          if (next && !prev && firedFor !== sessionId) {
            firedFor = sessionId;
            try { cbRef.current("row_update"); }
            catch (err) { console.error("[useScannerSessionRevocation] onRevoked", err); }
          }
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [sessionId]);
}
