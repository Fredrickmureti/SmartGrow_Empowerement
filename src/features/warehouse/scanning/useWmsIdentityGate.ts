/**
 * useWmsIdentityGate — Phase C2/C3 gate between a WMS scan intent and the
 * canonical product identity resolver.
 *
 * Every operational surface that scans a *product* (receiving, put-away,
 * picking, counting, goods receipt) must answer the same three questions
 * before it touches stock:
 *
 *   1. Which product is this? (identifier → product)
 *   2. Which packaging level was scanned? (each / inner / case / pallet)
 *   3. How many base ledger units does one scan of that level represent?
 *
 * The gate answers all three via `resolve_product_identity` and enforces the
 * hard rule from the plan: an unknown, ambiguous or unresolvable code
 * **blocks the line** — it is reported to `scanFeedbackBus` (audio + haptic)
 * and returns `null`. Surfaces must never fall back to posting the raw code
 * as a product, and never narrate the failure only in a toast.
 */
import { useCallback } from "react";
import { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";
import {
  useResolveProductIdentity,
  scanToBaseUnits,
  type ProductIdentity,
} from "@/hooks/inventory/useResolveProductIdentity";
import type { WmsScanPayload } from "./wmsScanIntent";

export interface GatedScan {
  identity: ProductIdentity;
  /** Base ledger units for ONE scan of the matched level. */
  baseUnits: number;
  /** Lot / serial / expiry carried on the label, when GS1. */
  lot: string | null;
  serial: string | null;
  expiry: Date | null;
}

export function describeLevel(identity: ProductIdentity): string {
  const level = identity.packagingName ?? (identity.isBaseUnit ? "each" : "unit");
  return identity.qtyInBaseUom > 1 ? `${level} × ${identity.qtyInBaseUom}` : level;
}

export function useWmsIdentityGate(
  businessId: string | undefined,
  branchId: string | null = null,
) {
  const { resolve, invalidate } = useResolveProductIdentity(businessId, branchId);

  /**
   * Resolve a scan payload to a gated identity, or `null` when the line must
   * be blocked. Feedback is emitted on every rejection path.
   */
  const gate = useCallback(
    async (
      p: Pick<WmsScanPayload, "raw" | "resolveCode"> & { workflow?: "receive" | "count" | "identity" },
    ): Promise<GatedScan | null> => {
      const workflow = p.workflow ?? "receive";
      const reject = (detail: string) => {
        scanFeedbackBus.emit({ kind: "error", raw: p.raw, source: "field", workflow, detail });
        return null;
      };

      const result = await resolve(p.raw || p.resolveCode);
      if (result.kind === "not_found") {
        return reject(`Unknown code ${result.code || p.resolveCode} — enrol it before receiving`);
      }
      if (result.kind === "error") {
        return reject(`Could not verify ${p.resolveCode} — ${result.err.message}`);
      }
      if (result.kind === "ambiguous") {
        return reject(
          `${p.resolveCode} matches ${result.matchCount} identifiers — resolve the duplicate first`,
        );
      }

      const identity = result.identity;
      const g = identity.gs1.normalized;
      return {
        identity,
        baseUnits: scanToBaseUnits(identity, 1),
        lot: g.lot ?? null,
        serial: g.serial ?? null,
        expiry: g.expiry ?? null,
      };
    },
    [resolve],
  );

  return { gate, invalidate };
}
