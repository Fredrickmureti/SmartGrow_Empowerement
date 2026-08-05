/**
 * dispatchPosReceipt — the single exit for re-issuing a POS receipt as a
 * document artifact.
 *
 * Wave 7.2. Back-office reprints (POS Reports → "PDF") used to call the
 * legacy `usePrintOrPreview` shim, which rendered bytes straight from
 * `generate-document` and left no print-job trail. A receipt is fiscal
 * paper: every re-issue must be archived and auditable, so it now goes
 * through the same snapshot → document record → output intent path as the
 * terminal itself.
 *
 * The snapshot is always the frozen `pos_receipt_snapshots.payload` written
 * by the `_pos_write_receipt_snapshot` trigger — never a live re-read — so a
 * reprint years later is byte-identical to the original.
 */
import { supabase } from "@/integrations/supabase/client";
import type { POSReceiptSnapshot } from "@/hooks/pos/useReceiptSnapshot";
import { buildPosReceiptSnapshot } from "@/services/documents/snapshots/posReceipt";
import { printSourceDocumentIntent } from "@/services/printing/PrintService";
import { withTrace, withSpan } from "@/services/observability/trace";

export interface DispatchPosReceiptArgs {
  /** `pos_transactions.id` of the receipt being re-issued. */
  transactionId: string;
  /** `customer` (default) or `merchant` copy. */
  copy?: "customer" | "merchant";
  /** Tenancy fallbacks used only when the frozen snapshot cannot resolve them. */
  organizationId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  /** Back-office re-issues are reprints; the terminal fires business events. */
  triggeredSource?: "manual" | "business_event" | "reprint" | "api";
  /**
   * Already-loaded frozen snapshot. Callers holding it (the terminal) pass
   * it to skip the `pos_receipt_snapshots` round trip.
   */
  frozen?: POSReceiptSnapshot;
}

export interface DispatchPosReceiptResult {
  documentRecordId: string;
  targetCount: number;
}

export async function fetchFrozenPosReceipt(
  transactionId: string,
): Promise<POSReceiptSnapshot> {
  const { data, error } = await supabase
    .from("pos_receipt_snapshots" as never)
    .select("payload")
    .eq("transaction_id", transactionId)
    .maybeSingle();

  if (error) {
    throw new Error(`fetchFrozenPosReceipt failed: ${error.message}`);
  }
  const payload = (data as { payload?: POSReceiptSnapshot } | null)?.payload;
  if (!payload) {
    throw new Error(
      `No frozen receipt snapshot for transaction ${transactionId}`,
    );
  }
  return payload;
}

export async function dispatchPosReceipt({
  transactionId,
  copy = "customer",
  organizationId,
  businessId,
  branchId,
  triggeredSource = "reprint",
  frozen: prefetched,
}: DispatchPosReceiptArgs): Promise<DispatchPosReceiptResult> {
  return withTrace(
    {
      label: "pos_receipt",
      attributes: {
        entry: "dispatchPosReceipt",
        transaction_id: transactionId,
        copy,
        triggered_source: triggeredSource,
      },
    },
    async () => {
      const frozen =
        prefetched ??
        (await withSpan("snapshot.fetch", () =>
          fetchFrozenPosReceipt(transactionId),
        ));
      const built = buildPosReceiptSnapshot({ frozen, copy });

      const resolvedOrgId =
        (frozen.organization?.id as string | undefined) ?? organizationId ?? null;
      if (!resolvedOrgId) {
        throw new Error(
          `dispatchPosReceipt: cannot resolve organization for transaction ${transactionId}`,
        );
      }

      // Phase 3: record materialization + intent submission + job read-back
      // are ONE round trip (`document_materialize_and_submit_intent`).
      const result = await printSourceDocumentIntent({
        kindCode:
          copy === "merchant" ? "pos.receipt_merchant" : "pos.receipt_customer",
        organizationId: resolvedOrgId,
        sourceModule: "pos",
        sourceDocType: copy === "merchant" ? "receipt_merchant" : "receipt",
        sourceDocId: transactionId,
        businessId: built.businessId ?? businessId ?? null,
        branchId: built.branchId ?? branchId ?? null,
        partyKind: built.partyKind,
        partyId: built.partyId,
        currency: built.currency,
        documentNumber: built.documentNumber,
        documentDate: built.documentDate,
        snapshot: built.snapshot,
        triggeredSource,
      });

      return {
        documentRecordId: result.document_record_id,
        targetCount: result.target_count,
      };
    },
  );
}

