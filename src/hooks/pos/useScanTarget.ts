/**
 * useScanTarget — register a focus-aware scan target with `scanRouter`.
 *
 * While `active` is true, the topmost registration wins the next scan.
 * Typical usage:
 *
 *   useScanTarget({ active: isFocused, onScan: (e) => setValue(e.code) })
 */

import { useEffect, useId } from "react";
import { scanRouter, type ScanWorkflow, type ScanIntent } from "@/services/pos/scanRouter";
import type { ScanEvent } from "@/services/pos/scanBus";

interface Options {
  active: boolean;
  onScan: (e: ScanEvent) => void;
  /** Higher wins ties. Focused fields use 10; ambient cart uses 0. */
  priority?: number;
  label?: string;
  /**
   * Skip the cross-source 250 ms dedupe while this target is topmost.
   * Required for counting / receiving screens where the same SKU is
   * legitimately scanned many times in quick succession.
   */
  allowRepeats?: boolean;
  /** Declarative workflow tag — see ScanWorkflow. */
  workflow?: ScanWorkflow;
  /**
   * Runtime intent contract — see ScanIntent. Two non-identity intents
   * at the same priority cannot coexist; the router rejects the second
   * registration and logs an error. Wire this on every workspace-level
   * target so the contract is enforced.
   */
  intent?: ScanIntent;
  /** See `ScanTargetEntry.acceptsTopic`. */
  acceptsTopic?: (sourceTopic: string | undefined, source: ScanEvent["source"]) => boolean;
}

export function useScanTarget({
  active,
  onScan,
  priority = 10,
  label,
  allowRepeats,
  workflow,
  intent,
  acceptsTopic,
}: Options) {
  const id = useId();
  useEffect(() => {
    if (!active) return;
    const unregister = scanRouter.register({
      id,
      priority,
      label,
      onScan,
      allowRepeats,
      workflow,
      intent,
      acceptsTopic,
    });
    return unregister;
  }, [active, id, priority, label, onScan, allowRepeats, workflow, intent, acceptsTopic]);
}

