/**
 * dispatchGoodsReceipt — the single exit for sending a saved Goods Received
 * Note into the document engine.
 *
 * Wave 7.2. Receiving is the first moment a purchase becomes physical, and
 * the GRN is the paper that proves it. Routing it through the same
 * snapshot → document record → output intent path as every other document
 * means the receiving copy is archived and audited exactly like a vendor
 * bill, instead of being a one-off print that leaves no trace.
 */
import { supabase } from "@/integrations/supabase/client";
import { fetchAndBuildPurchasesGrnSnapshot } from "@/services/documents/snapshots/purchasesGrn";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { submitDocumentIntent } from "@/services/documents/submitIntent";

export interface DispatchGoodsReceiptArgs {
  /** `goods_receipts.id` of the saved receipt. */
  goodsReceiptId: string;
  /** Tenancy fallbacks used only when the snapshot cannot resolve them. */
  organizationId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  /** Receiving normally fires from the wizard completing — a business event. */
  triggeredSource?: "manual" | "business_event" | "reprint" | "api";
}

export interface DispatchGoodsReceiptResult {
  documentRecordId: string;
  targetCount: number;
}

export async function dispatchGoodsReceipt({
  goodsReceiptId,
  organizationId,
  businessId,
  branchId,
  triggeredSource = "business_event",
}: DispatchGoodsReceiptArgs): Promise<DispatchGoodsReceiptResult> {
  const built = await fetchAndBuildPurchasesGrnSnapshot(supabase, goodsReceiptId);

  const documentRecordId = await ensureDocumentRecord({
    kindCode: "purchases.grn",
    organizationId: organizationId ?? built.organizationId,
    sourceModule: "purchases",
    sourceDocType: "goods_receipt",
    sourceDocId: goodsReceiptId,
    businessId: built.businessId ?? businessId ?? null,
    branchId: built.branchId ?? branchId ?? null,
    partyKind: "supplier",
    partyId: built.vendorId,
    currency: built.currency,
    documentNumber: built.documentNumber,
    documentDate: built.documentDate,
    snapshot: built.snapshot,
  });

  const result = await submitDocumentIntent({
    documentRecordId,
    triggeredSource,
  });

  return { documentRecordId, targetCount: result.target_count };
}
