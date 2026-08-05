/**
 * useActiveScanTarget — who owns the scan stream right now (Phase 4.1).
 *
 * Subscribes to `scanRouter`'s change notification instead of polling it,
 * so a guidance surface is instant and costs nothing while the stack is
 * stable. One `useSyncExternalStore` per mounted surface, no timers.
 */
import { useSyncExternalStore } from "react";
import { scanRouter } from "@/services/pos/scanRouter";

export interface ActiveScanTarget {
  id: string;
  label: string | null;
}

function subscribe(cb: () => void) {
  return scanRouter.subscribe(cb);
}

function getVersion() {
  return scanRouter.getStackVersion();
}

/** The target that would receive the next scan, or null when nothing is armed. */
export function useActiveScanTarget(): ActiveScanTarget | null {
  // The version token is the store snapshot (stable identity between
  // changes); the target itself is read after each notification.
  useSyncExternalStore(subscribe, getVersion, () => 0);
  const targets = scanRouter.getActiveTargets();
  const top = targets[0];
  if (!top) return null;
  return { id: top.id, label: top.label ?? null };
}
