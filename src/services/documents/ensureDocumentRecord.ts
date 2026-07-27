/**
 * Wave 7.1.5 — ensureDocumentRecord client shim.
 *
 * Materializes (idempotently) a `document_records` row for a given source
 * document (module + doc type + id) and returns its id. Callers pass the id
 * to {@link submitDocumentIntent} to enqueue the routing plan.
 *
 * This is the ONLY sanctioned way for app code to obtain a
 * `document_record_id`. Direct inserts into `public.document_records` from
 * the frontend are prohibited by architecture guard.
 */
import { supabase } from "@/integrations/supabase/client";

export interface EnsureDocumentRecordInput {
  /** `document_kinds.code`, e.g. `pos.receipt_customer`, `sales.invoice`. */
  kindCode: string;
  organizationId: string;
  /** Origin subsystem: `pos`, `sales`, `purchases`, `inventory`, `hr`, `payroll`, `finance`, `mfg`. */
  sourceModule: string;
  /** Subtype within the module, e.g. `invoice`, `receipt`, `bill`, `payslip`. */
  sourceDocType: string;
  /** Primary key of the source row (uuid). */
  sourceDocId: string;
  businessId?: string | null;
  branchId?: string | null;
  partyKind?: "customer" | "supplier" | "employee" | null;
  partyId?: string | null;
  currency?: string | null;
  locale?: string | null;
  /** Freeform metadata merged into `document_records.metadata`. */
  metadata?: Record<string, unknown>;
}

export async function ensureDocumentRecord(
  input: EnsureDocumentRecordInput,
): Promise<string> {
  const { data, error } = await supabase.rpc("ensure_document_record", {
    p_kind_code: input.kindCode,
    p_organization_id: input.organizationId,
    p_source_module: input.sourceModule,
    p_source_doc_type: input.sourceDocType,
    p_source_doc_id: input.sourceDocId,
    p_business_id: input.businessId ?? null,
    p_branch_id: input.branchId ?? null,
    p_party_kind: input.partyKind ?? null,
    p_party_id: input.partyId ?? null,
    p_currency: input.currency ?? null,
    p_locale: input.locale ?? null,
    p_metadata: (input.metadata ?? {}) as never,
  });

  if (error) {
    throw new Error(`ensureDocumentRecord failed: ${error.message}`);
  }
  if (typeof data !== "string") {
    throw new Error(
      `ensureDocumentRecord returned unexpected payload: ${JSON.stringify(data)}`,
    );
  }
  return data;
}
