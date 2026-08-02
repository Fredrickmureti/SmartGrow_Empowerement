/**
 * dispatchReturnDocument — the single exit for sending returns paperwork into
 * the document engine (Returns rebuild, Phase 6).
 *
 * Mirrors `dispatchGoodsReceipt`: snapshot → `document_records` →
 * `printDocumentIntent`. Returns never builds a PDF, never talks to a printer
 * and never inserts into `document_records` directly; the archive and the
 * routing plan are the platform's job.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  fetchAndBuildReturnDocumentSnapshot,
  type ReturnDocumentKind,
} from "@/services/documents/snapshots/wmsReturn";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { resolveSourceDocumentRecordId } from "@/services/documents/resolveSourceDocumentRecord";
import { printDocumentIntent } from "@/services/printing/PrintService";

const SOURCE_DOC_TYPE: Record<ReturnDocumentKind, string> = {
  "wms.rma_authorization": "return_authorization",
  "wms.return_receipt": "return_receipt",
  "wms.inspection_report": "return_inspection",
  "wms.damage_report": "return_damage",
};

export interface DispatchReturnDocumentArgs {
  returnId: string;
  kind: ReturnDocumentKind;
  triggeredSource?: "manual" | "business_event" | "reprint" | "api";
}

export interface DispatchReturnDocumentResult {
  documentRecordId: string;
  targetCount: number;
}

export async function dispatchReturnDocument({
  returnId,
  kind,
  triggeredSource = "manual",
}: DispatchReturnDocumentArgs): Promise<DispatchReturnDocumentResult> {
  const built = await fetchAndBuildReturnDocumentSnapshot(supabase, returnId, kind);

  const documentRecordId = await ensureDocumentRecord({
    kindCode: kind,
    organizationId: built.organizationId,
    sourceModule: "wms",
    sourceDocType: SOURCE_DOC_TYPE[kind],
    sourceDocId: returnId,
    businessId: built.businessId,
    branchId: built.branchId,
    partyKind: built.partyKind,
    partyId: built.partyId,
    currency: built.currency,
    documentNumber: built.documentNumber,
    documentDate: built.documentDate,
    snapshot: built.snapshot,
  });

  const result = await printDocumentIntent({ documentRecordId, triggeredSource });
  return { documentRecordId, targetCount: result.target_count };
}

/**
 * dispatchVendorReturnNote — Phase 6.5.
 *
 * A `return_to_vendor` disposition ships goods back to the supplier. The
 * physical ship-back paper is NOT a new document kind: it reuses the existing
 * `purchases.return` kind rendered from the linked `purchase_returns` row that
 * `wms_create_return_finance_doc` raised. Warehouse only resolves the record
 * and asks the platform to route it.
 */
export async function dispatchVendorReturnNote(
  returnId: string,
  triggeredSource: "manual" | "business_event" | "reprint" | "api" = "manual",
): Promise<DispatchReturnDocumentResult> {
  const { data, error } = await supabase
    .from("wms_return_orders")
    .select("id, finance_doc_type, finance_doc_id, organization_id, business_id, branch_id")
    .eq("id", returnId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("return_not_found");
  if (data.finance_doc_type !== "purchase_return" || !data.finance_doc_id) {
    throw new Error(
      "raise the purchase return in Finance before printing the vendor return note",
    );
  }

  const documentRecordId = await resolveSourceDocumentRecordId(
    "purchase_return",
    data.finance_doc_id,
    {
      organizationId: data.organization_id,
      businessId: data.business_id,
      branchId: data.branch_id,
    },
  );
  const result = await printDocumentIntent({ documentRecordId, triggeredSource });
  return { documentRecordId, targetCount: result.target_count };
}
