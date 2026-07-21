/**
 * useLabelPrint — shared caller-side seam for every "Print label" action
 * across Inventory / Warehouse / POS.
 *
 * Centralises the four rules every label-printing page must obey:
 *   1. Refuse when no `label_printer` is bound and surface the same
 *      missing-device CTA (`useInventoryLabelPrinter`).
 *   2. Never encode a UUID — go through `resolveLabelBarcode`
 *      (ADR-0089); on refusal show the standard toast and CTA.
 *   3. Dispatch through `printLabelByTemplate` with a workflow key so
 *      the workflow-bound printer resolver picks the right physical
 *      device per branch/warehouse (ADR-0086).
 *   4. Emit a consistent success/failure toast so operators don't
 *      encounter three different phrasings across the app.
 *
 * Adding a "Print label" button anywhere in the app is now one call:
 *
 *   const { print, missingDeviceCta } = useLabelPrint();
 *   await print({
 *     templateKey: 'shelf_label',
 *     workflow: 'shelf_edge',
 *     product,
 *     extraVars: { price: '$4.99' },
 *   });
 */

import { useCallback } from "react";
import { toast } from "sonner";
import { useOrganization } from "@/hooks/useOrganization";
import { useInventoryLabelPrinter } from "@/hooks/inventory/useInventoryLabelPrinter";
import {
  printLabelByTemplate,
  type PrinterWorkflow,
  type LabelDispatchResult,
} from "@/services/printing/labelDispatch";
import {
  resolveLabelBarcode,
  LABEL_BARCODE_REFUSAL,
  type PrintableProduct,
} from "@/services/printing/labelBarcode";

export interface UseLabelPrintOptions {
  branchId?: string | null;
  warehouseId?: string | null;
}

export interface PrintLabelArgs {
  templateKey: string;
  workflow: PrinterWorkflow;
  /** The product/entity being labelled. Provides name + barcode identity. */
  product: PrintableProduct;
  /** Extra template vars beyond `name`, `sku`, `sku_display`, `barcode`, `hri_flag`. */
  extraVars?: Record<string, string | number | null | undefined>;
  /** Optional lot metadata for pharmacy/food-retail (ADR-0086 Track 3). */
  lotNumber?: string | null;
  expiryDate?: string | null;
  manufactureDate?: string | null;
  /** Audit linkage. `sourceDocId` defaults to `product.id`. */
  sourceDocType?: string;
  sourceDocId?: string;
  idempotencyKey?: string;
}

export interface PrintLabelResult extends LabelDispatchResult {
  refused?: "no-printer" | "no-org" | "no-identity";
}

export function useLabelPrint(opts: UseLabelPrintOptions = {}) {
  const { currentOrg, currentBranch } = useOrganization();
  const labelPrinter = useInventoryLabelPrinter();

  const branchId = opts.branchId ?? currentBranch?.id ?? null;
  const warehouseId = opts.warehouseId ?? null;

  const print = useCallback(
    async (args: PrintLabelArgs): Promise<PrintLabelResult> => {
      if (labelPrinter.missingDeviceCta) {
        toast.error("No label printer assigned", {
          description: labelPrinter.missingDeviceCta.message,
        });
        return { success: false, error: "no-printer", refused: "no-printer" };
      }
      if (!currentOrg?.id) {
        toast.error("No active organization", {
          description: "Select an organization before printing labels.",
        });
        return { success: false, error: "no-org", refused: "no-org" };
      }
      const identity = resolveLabelBarcode(args.product);
      if (!identity) {
        toast.error(LABEL_BARCODE_REFUSAL.title, {
          description: LABEL_BARCODE_REFUSAL.description,
        });
        return { success: false, error: "no-identity", refused: "no-identity" };
      }
      const vars: Record<string, string | number | null | undefined> = {
        name: (args.product.name || "").slice(0, 80),
        sku: identity.skuDisplay,
        sku_display: identity.skuDisplay,
        barcode: identity.code,
        hri_flag: identity.hri,
        ...args.extraVars,
      };
      const result = await printLabelByTemplate({
        orgId: currentOrg.id,
        branchId,
        warehouseId,
        templateKey: args.templateKey,
        workflow: args.workflow,
        vars,
        lotNumber: args.lotNumber ?? null,
        expiryDate: args.expiryDate ?? null,
        manufactureDate: args.manufactureDate ?? null,
        sourceDocType: args.sourceDocType ?? "product",
        sourceDocId: args.sourceDocId ?? args.product.id ?? undefined,
        idempotencyKey:
          args.idempotencyKey ??
          `${args.templateKey}:${args.product.id ?? "manual"}:${Date.now()}`,
      });
      if (result.success) {
        toast.success("Label sent to printer", {
          description: `Sent ${args.templateKey} for ${
            args.product.name ?? identity.skuDisplay ?? "item"
          }.`,
        });
      } else {
        toast.error("Print failed", {
          description: result.error ?? "Unknown printer error",
        });
      }
      return result;
    },
    [currentOrg?.id, branchId, warehouseId, labelPrinter],
  );

  return {
    print,
    missingDeviceCta: labelPrinter.missingDeviceCta,
    device: labelPrinter.device,
  };
}
