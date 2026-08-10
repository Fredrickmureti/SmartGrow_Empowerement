/**
 * dispatchCustomerStatement — the single exit for sending a saved Customer
 * Statement into the document engine.
 *
 * Mirrors `dispatchVendorStatement` (Wave 7.2) so both sides of the same
 * document class take the same route into the engine. Before this module the
 * AR side had no single exit: each surface called the export helper inline
 * with its own document-type string and filename, so a divergence between the
 * list action, the peek sheet and the record page was one edit away.
 *
 * Two dispositions, one snapshot:
 *
 *   • `downloadCustomerStatement` — renders the frozen snapshot to bytes and
 *     hands them to the browser. It never touches hardware and never mints a
 *     print job. `resolve_output_intent` additionally refuses to attach a
 *     transactional print policy's printer target to a statement kind, so a
 *     download cannot acquire a physical printer as a side effect.
 *   • `dispatchCustomerStatement` — the explicit print/output-intent path,
 *     used only when an operator asks to print.
 *
 * Callers never speak `generate-document`, a raw document type string, or the
 * legacy print shim.
 */
import { supabase } from "@/integrations/supabase/client";
import { fetchAndBuildCustomerStatementSnapshot } from "@/services/documents/snapshots/salesCustomerStatement";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { startPrintDocumentIntent } from "@/services/printing/PrintService";
import { downloadExport, type ExportResult } from "@/services/exports";

/** The ONE legacy `(documentType, documentId)` pair for this kind. */
export const CUSTOMER_STATEMENT_DOC_TYPE = "customer_statement" as const;

export interface CustomerStatementFileArgs {
  /** `customer_statements.id` of the saved statement. */
  statementId: string;
  /** Extract medium. `pdf` is a download, not a print job. */
  format: "pdf" | "csv" | "xlsx";
  /** Contact name used in the offered filename. */
  contactName?: string | null;
  /** Statement date or period start, used in the offered filename. */
  dateLabel?: string | null;
  /** Optional period end; included in the filename when present. */
  periodEndLabel?: string | null;
}

/** Deterministic, operator-legible filename for every AR statement surface. */
export function customerStatementFilename(args: CustomerStatementFileArgs): string {
  const parts = [
    "customer-statement",
    (args.contactName ?? "contact").trim().replace(/\s+/g, "-").toLowerCase() || "contact",
    args.dateLabel ?? null,
    args.periodEndLabel ?? null,
  ].filter(Boolean);
  return `${parts.join("-")}.${args.format}`;
}

/**
 * DOWNLOAD disposition. Renders the frozen snapshot and hands the bytes to
 * the browser. Never throws — surfaces get a structured result.
 */
export async function downloadCustomerStatement(
  args: CustomerStatementFileArgs,
): Promise<ExportResult> {
  return downloadExport({
    documentType: CUSTOMER_STATEMENT_DOC_TYPE,
    documentId: args.statementId,
    format: args.format,
    filename: customerStatementFilename(args),
  });
}

export interface DispatchCustomerStatementArgs {
  /** `customer_statements.id` of the saved statement. */
  statementId: string;
  /** Tenancy fallbacks used only when the snapshot cannot resolve them. */
  organizationId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  /** Defaults to a manual operator action. */
  triggeredSource?: "manual" | "business_event" | "reprint" | "api";
}

export interface DispatchCustomerStatementResult {
  documentRecordId: string;
  targetCount: number;
}

/**
 * PRINT / output-intent disposition: freeze the snapshot into a document
 * record and enqueue the resolved output targets.
 */
export async function dispatchCustomerStatement({
  statementId,
  organizationId,
  businessId,
  branchId,
  triggeredSource = "manual",
}: DispatchCustomerStatementArgs): Promise<DispatchCustomerStatementResult> {
  const built = await fetchAndBuildCustomerStatementSnapshot(supabase, statementId);
  // The snapshot result carries tenancy but not the counterparty id; the
  // document record's party link is read from the statement header.
  const { data: header } = await supabase
    .from("customer_statements")
    .select("contact_id")
    .eq("id", statementId)
    .maybeSingle();

  const documentRecordId = await ensureDocumentRecord({
    kindCode: "sales.statement",
    organizationId: organizationId ?? built.organizationId,
    sourceModule: "sales",
    sourceDocType: CUSTOMER_STATEMENT_DOC_TYPE,
    sourceDocId: statementId,
    businessId: built.businessId ?? businessId ?? null,
    branchId: built.branchId ?? branchId ?? null,
    partyKind: "customer",
    partyId: (header as { contact_id?: string } | null)?.contact_id ?? null,
    currency: built.currency,
    documentNumber: built.documentNumber,
    documentDate: built.documentDate,
    snapshot: built.snapshot,
  });

  const ack = await startPrintDocumentIntent({ documentRecordId, triggeredSource });
  if (!ack.queued) {
    throw new Error(ack.error ?? "Failed to queue customer statement");
  }

  return { documentRecordId, targetCount: ack.targetCount };
}
