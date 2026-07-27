/**
 * dispatchVendorStatement — the single exit for sending a saved Vendor
 * Statement into the document engine.
 *
 * Wave 7.2. Every vendor-statement surface (list page "PDF" action, peek
 * sheet, full record page) funnels through here so there is exactly one
 * implementation of snapshot → document record → output intent for this
 * document kind. Callers never touch `generate-document` or the legacy
 * `usePrintOrPreview` shim, which means archive rules, disposition rules
 * and the print-job audit trail cannot be bypassed by a manual click.
 */
import { supabase } from "@/integrations/supabase/client";
import { fetchAndBuildVendorStatementSnapshot } from "@/services/documents/snapshots/purchasesVendorStatement";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { submitDocumentIntent } from "@/services/documents/submitIntent";

export interface DispatchVendorStatementArgs {
  /** `vendor_statements.id` of the saved statement. */
  statementId: string;
  /** Tenancy fallbacks used only when the snapshot cannot resolve them. */
  organizationId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  /** Defaults to a manual operator action. */
  triggeredSource?: "manual" | "business_event" | "reprint" | "api";
}

export interface DispatchVendorStatementResult {
  documentRecordId: string;
  targetCount: number;
}

export async function dispatchVendorStatement({
  statementId,
  organizationId,
  businessId,
  branchId,
  triggeredSource = "manual",
}: DispatchVendorStatementArgs): Promise<DispatchVendorStatementResult> {
  const built = await fetchAndBuildVendorStatementSnapshot(supabase, statementId);

  const documentRecordId = await ensureDocumentRecord({
    kindCode: "purchases.statement",
    organizationId: organizationId ?? built.organizationId,
    sourceModule: "purchases",
    sourceDocType: "vendor_statement",
    sourceDocId: statementId,
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
