/**
 * useNativeScanner — mounts the appropriate vendor adapter (Zebra
 * DataWedge or Honeywell DataCollection) when the device exposes one,
 * and delivers normalized scans to the caller's `onScan` callback.
 *
 * On consumer phones / desktops / iOS the hook is a no-op and reports
 * `vendor: null` so the page falls back to camera + keyboard wedge.
 *
 * The hook is the ONLY allowed consumer of the `src/services/scanner/native/`
 * adapters — enforced by `src/test/architecture/native-scanner-seam.test.ts`.
 */

import { useEffect, useRef, useState } from "react";
import {
  detectNativeScanner,
  type NativeScannerCapability,
} from "@/services/scanner/native/detectNativeScanner";
import { dataWedgeAdapter } from "@/services/scanner/native/dataWedgeAdapter";
import { honeywellAdapter } from "@/services/scanner/native/honeywellAdapter";
import { swiftDecoderAdapter } from "@/services/scanner/native/swiftDecoderAdapter";
import { nativeScanBus, type NativeScan } from "@/services/scanner/native/nativeScanBus";


interface Args {
  /** Operator toggle — when false the adapter is detached even on a Zebra device. */
  enabled: boolean;
  onScan: (scan: NativeScan) => void;
}

export interface NativeScannerState {
  capability: NativeScannerCapability;
  active: boolean;
}

export function useNativeScanner({ enabled, onScan }: Args): NativeScannerState {
  const [capability] = useState<NativeScannerCapability>(() => detectNativeScanner());
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!enabled || !capability.vendor) {
      setActive(false);
      return;
    }

    const adapter =
      capability.vendor === "zebra" ? dataWedgeAdapter
      : capability.vendor === "honeywell-ios" ? swiftDecoderAdapter
      : honeywellAdapter;
    const unsub = nativeScanBus.on((scan) => onScanRef.current(scan));

    const start = () => {
      adapter.start();
      setActive(true);
    };
    const stop = () => {
      adapter.stop();
      setActive(false);
    };

    start();

    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
      unsub();
    };
  }, [enabled, capability.vendor]);

  return { capability, active };
}
