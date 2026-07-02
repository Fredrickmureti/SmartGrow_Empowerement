/**
 * useActiveScanContext — declare the active workspace scan context.
 *
 * Mount this once at the top of a workspace screen (POSTerminal,
 * PhysicalCount, GRN scan) so dispatched scans land in `scan_events`
 * with a resolvable `register_id` / `session_id`. The router skips
 * audit emission when no context is active.
 */

import { useEffect } from "react";
import { scanRouter, type ActiveScanContext } from "@/services/pos/scanRouter";

export function useActiveScanContext(ctx: ActiveScanContext | null | undefined): void {
  const registerId = ctx?.register_id ?? null;
  const sessionId = ctx?.session_id ?? null;
  const deviceId = ctx?.device_id ?? null;
  const workspaceId = ctx?.workspace_id ?? null;
  useEffect(() => {
    if (!registerId && !sessionId && !workspaceId) {
      // Nothing to declare — leave any prior context untouched. The
      // owning screen is responsible for clearing on its own unmount.
      return;
    }
    scanRouter.setActiveContext({
      register_id: registerId,
      session_id: sessionId,
      device_id: deviceId,
      workspace_id: workspaceId,
    });
    return () => {
      const current = scanRouter.getActiveContext();
      // Only clear if we're still the active owner — guards against a
      // sibling screen having taken over before our cleanup runs.
      if (
        current &&
        current.register_id === registerId &&
        current.session_id === sessionId &&
        current.workspace_id === workspaceId
      ) {
        scanRouter.setActiveContext(null);
      }
    };
  }, [registerId, sessionId, deviceId, workspaceId]);
}
