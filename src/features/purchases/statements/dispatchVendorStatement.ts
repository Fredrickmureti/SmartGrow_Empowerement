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
 *
 * Two dispositions, one snapshot — mirroring `dispatchCustomerStatement`:
 *
 *   • `downloadVendorStatement` — renders the frozen snapshot to bytes and
 *     hands them to the browser. It never touches hardware and never mints a
 *     print job.
 *   • `dispatchVendorStatement` — the explicit print/output-intent path,
 *     used only when an operator asks to print.
 */
import { supabase } from "@/integrations/supabase/client";
import { fetchAndBuildVendorStatementSnapshot } from "@/services/documents/snapshots/purchasesVendorStatement";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { startPrintDocumentIntent } from "@/services/printing/PrintService";
import { downloadExport, type ExportResult } from "@/services/exports";

/** The ONE legacy `(documentType, documentId)` pair for this kind. */
export const VENDOR_STATEMENT_DOC_TYPE = "vendor_statement" as const;

export interface VendorStatementFileArgs {
  /** `vendor_statements.id` of the saved statement. */
  statementId: string;
  /** Extract medium. `pdf` is a download, not a print job. */
  format: "pdf" | "csv" | "xlsx";
  /** Vendor name used in the offered filename. */
  contactName?: string | null;
  /** Statement date or period start, used in the offered filename. */
  dateLabel?: string | null;
  /** Optional period end; included in the filename when present. */
  periodEndLabel?: string | null;
}

/** Deterministic, operator-legible filename for every AP statement surface. */
export function vendorStatementFilename(args: VendorStatementFileArgs): string {
  const parts = [
    "vendor-statement",
    (args.contactName ?? "vendor").trim().replace(/\s+/g, "-").toLowerCase() || "vendor",
    args.dateLabel ?? null,
    args.periodEndLabel ?? null,
  ].filter(Boolean);
  return `${parts.join("-")}.${args.format}`;
}

/**
 * DOWNLOAD disposition. Renders the frozen snapshot and hands the bytes to
 * the browser. Never throws — surfaces get a structured result.
 */
export async function downloadVendorStatement(
  args: VendorStatementFileArgs,
): Promise<ExportResult> {
  return downloadExport({
    documentType: VENDOR_STATEMENT_DOC_TYPE,
    documentId: args.statementId,
    format: args.format,
    filename: vendorStatementFilename(args),
  });
}


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

  // Non-blocking (Phase 5): released at the durable enqueue, drained in
  // the background.
  const ack = await startPrintDocumentIntent({ documentRecordId, triggeredSource });
  if (!ack.queued) {
    throw new Error(ack.error ?? "Failed to queue vendor statement");
  }

  return { documentRecordId, targetCount: ack.targetCount };
}
