/**
 * useBatteryStatus — feature-detected wrapper over the Battery Status
 * API. Returns `null` on platforms that don't expose it (iOS Safari,
 * desktop Firefox), so the caller renders nothing rather than a
 * misleading "100%".
 *
 * Refreshes on `levelchange` and `chargingchange`; no polling.
 */

import { useEffect, useState } from "react";

export interface BatteryStatus {
  /** 0–1, multiply by 100 for percent. */
  level: number;
  charging: boolean;
}

interface BatteryManager extends EventTarget {
  level: number;
  charging: boolean;
}

export function useBatteryStatus(): BatteryStatus | null {
  const [status, setStatus] = useState<BatteryStatus | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const getBattery = (navigator as unknown as { getBattery?: () => Promise<BatteryManager> }).getBattery;
    if (typeof getBattery !== "function") return;

    let cancelled = false;
    let mgr: BatteryManager | null = null;
    const update = () => {
      if (!mgr || cancelled) return;
      setStatus({ level: mgr.level, charging: mgr.charging });
    };

    getBattery.call(navigator).then((b) => {
      if (cancelled) return;
      mgr = b;
      update();
      b.addEventListener("levelchange", update);
      b.addEventListener("chargingchange", update);
    }).catch(() => { /* unsupported, stays null */ });

    return () => {
      cancelled = true;
      if (mgr) {
        mgr.removeEventListener("levelchange", update);
        mgr.removeEventListener("chargingchange", update);
      }
    };
  }, []);

  return status;
}
