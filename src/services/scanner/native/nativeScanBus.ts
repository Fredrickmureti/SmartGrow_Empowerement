/**
 * nativeScanBus — tiny pub/sub the vendor adapters emit into. The page
 * mounts a single subscriber regardless of vendor, so swapping
 * DataWedge ↔ Honeywell ↔ a future Datalogic shim is a one-line change.
 */

export interface NativeScan {
  code: string;
  symbology?: string | null;
  /** AIM code identifier ("]C0", "]E0", …) when the engine reports it. */
  aim?: string | null;
  source: "zebra" | "honeywell" | "honeywell-ios";
  at: number;
}

type Listener = (scan: NativeScan) => void;

const listeners = new Set<Listener>();

export const nativeScanBus = {
  on(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(scan: NativeScan): void {
    for (const fn of listeners) {
      try { fn(scan); } catch (err) {
        // Never let a downstream throw kill the adapter.
        console.error("[nativeScanBus] listener error", err);
      }
    }
  },
  /** Test-only — clears all subscribers. */
  _reset(): void { listeners.clear(); },
};
