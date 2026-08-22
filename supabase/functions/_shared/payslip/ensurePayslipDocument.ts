/**
 * ensurePayslipDocument — the single implementation of "materialise the
 * immutable document_records row for a payslip".
 *
 * It lives in `_shared` because it is reachable through two doors:
 *   - `ensure-payslip-document` (the canonical endpoint), and
 *   - `generate-payslip-pdf` with `{ mode: "ensure_document" }` (a
 *     compatibility door so an environment where the canonical function
 *     is not deployed still serves interactive payslips instead of
 *     failing the browser with a CORS/404 preflight error).
 *
 * Both doors share this body, so there is exactly one payslip snapshot
 * and one document record shape regardless of which one was used.
 */
import {
  buildPayslipSnapshot,
  PayslipNotFoundError,
} from "./payslipSnapshot.ts";
import { authorizePayslipAccess, isDenied } from "./payslipAccess.ts";

export interface EnsurePayslipDocumentInput {
  payslipId?: string | null;
  payrollRunId?: string | null;
  employeeId?: string | null;
}

export interface EnsurePayslipDocumentResult {
  status: number;
  body: Record<string, unknown>;
  /** Set when authorization produced its own Response. */
  response?: Response;
}

export async function ensurePayslipDocument(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  req: Request,
  input: EnsurePayslipDocumentInput,
  corsHeaders: Record<string, string>,
  source: string,
): Promise<EnsurePayslipDocumentResult> {
  const payslipId = input.payslipId ?? null;
  const payrollRunId = input.payrollRunId ?? null;
  const employeeId = input.employeeId ?? null;

  if (!payslipId && !(payrollRunId && employeeId)) {
    return { status: 400, body: { error: "Provide payslip_id or payroll_run_id + employee_id" } };
  }

  let built;
  try {
    built = await buildPayslipSnapshot(supabase, { payslipId, payrollRunId, employeeId });
  } catch (err) {
    if (err instanceof PayslipNotFoundError) {
      return { status: 404, body: { error: "Payslip not found", detail: err.message } };
    }
    throw err;
  }

  const access = await authorizePayslipAccess({
    supabase,
    req,
    organizationId: built.organizationId,
    employeeId: built.employeeId,
    corsHeaders,
  });
  if (isDenied(access)) return { status: 403, body: {}, response: access.denied };

  if (!built.organizationId) {
    return { status: 422, body: { error: "payslip has no organization; cannot archive" } };
  }

  const { data: recordId, error: rpcError } = await supabase.rpc("ensure_document_record", {
    p_kind_code: "payroll.payslip",
    p_organization_id: built.organizationId,
    p_source_module: "payroll",
    p_source_doc_type: "payslip",
    p_source_doc_id: built.snapshot.payslip_id,
    p_business_id: built.businessId,
    p_branch_id: built.branchId,
    p_party_kind: built.employeeId ? "employee" : null,
    p_party_id: built.employeeId,
    p_currency: built.currency,
    p_locale: null,
    p_metadata: { source },
    p_document_number: built.documentNumber,
    p_document_date: built.documentDate,
    p_snapshot: built.snapshot,
  });

  if (rpcError) {
    console.error(`[${source}] ensure_document_record failed`, rpcError);
    return { status: 500, body: { error: "document_record_failed", detail: rpcError.message } };
  }

  return {
    status: 200,
    body: {
      document_record_id: recordId,
      document_number: built.documentNumber,
      filename: built.filename,
      organization_id: built.organizationId,
      business_id: built.businessId,
      branch_id: built.branchId,
    },
  };
}
