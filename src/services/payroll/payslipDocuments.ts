/**
 * Payslip documents — the one client-side payslip on-ramp.
 *
 * A payslip is a document, not a download. Every payslip surface (self
 * service, employee file, payroll run detail, payslip detail page) calls
 * `downloadPayslipPdf` / `printPayslip` here, and both go:
 *
 *   ensure-payslip-document  →  document_records row (frozen snapshot)
 *   PrintService             →  print_jobs ledger row + render-document
 *
 * Nothing in `src/` may invoke `generate-payslip-pdf` any more: that
 * endpoint is a server-to-server shim for outbound email. Routing every
 * interactive payslip through the document model is what gives payroll
 * the same reprint history, audit trail and byte-identical archive that
 * sales documents already have (ADR-0084).
 */
import { supabase } from '@/integrations/supabase/client';
import { PrintService } from '@/services/printing/PrintService';

export interface PayslipDocumentRef {
  documentRecordId: string;
  documentNumber: string | null;
  filename: string;
  organizationId: string | null;
  businessId: string | null;
  branchId: string | null;
}

/**
 * Materialise (or reuse) the immutable `document_records` row for a
 * payslip. The projection needs service-role reads, so it is built
 * server-side; this call is idempotent per payslip.
 *
 * Resilience: if `ensure-payslip-document` is unreachable in the target
 * environment (not deployed → 404 on the CORS preflight, which surfaces
 * in the browser as a blocked request), we retry against the always
 * deployed `generate-payslip-pdf` shim with `mode: 'ensure_document'`.
 * Both doors run the same shared server implementation, so the resulting
 * document record is identical.
 */
async function invokeEnsure(
  fn: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) throw new Error(error.message || 'Failed to prepare payslip document');

  const payload = (typeof data === 'string' ? JSON.parse(data) : data) as
    | (Record<string, unknown> & { document_record_id?: string; error?: string })
    | null;
  if (payload?.error) throw new Error(String(payload.error));
  if (!payload?.document_record_id) throw new Error('Payslip document was not created');
  return payload;
}

export async function ensurePayslipDocumentRecord(
  payslipId: string,
): Promise<PayslipDocumentRef> {
  let payload: Record<string, unknown>;
  try {
    payload = await invokeEnsure('ensure-payslip-document', { payslip_id: payslipId });
  } catch (primaryError) {
    try {
      payload = await invokeEnsure('generate-payslip-pdf', {
        payslip_id: payslipId,
        mode: 'ensure_document',
      });
    } catch {
      throw primaryError instanceof Error
        ? primaryError
        : new Error('Failed to prepare payslip document');
    }
  }

  return {
    documentRecordId: String(payload.document_record_id),
    documentNumber: (payload.document_number as string | null) ?? null,
    filename: (payload.filename as string | undefined) ?? `payslip-${payslipId}`,
    organizationId: (payload.organization_id as string | null) ?? null,
    businessId: (payload.business_id as string | null) ?? null,
    branchId: (payload.branch_id as string | null) ?? null,
  };
}


/** Download a payslip as a ledgered document. */
export async function downloadPayslipPdf(
  payslipId: string,
  opts?: { filename?: string },
): Promise<void> {
  const ref = await ensurePayslipDocumentRecord(payslipId);
  const result = await PrintService.downloadDocumentRecord({
    documentRecordId: ref.documentRecordId,
    filename: opts?.filename ?? ref.filename,
    businessId: ref.businessId,
    branchId: ref.branchId,
    documentType: 'payslip',
    documentId: payslipId,
    intent: 'payslip_download',
  });
  if (!result.success) throw new Error(result.error ?? 'Failed to download payslip');
}

/** Print a payslip through the routing plan (print / email / archive). */
export async function printPayslip(payslipId: string): Promise<void> {
  const ref = await ensurePayslipDocumentRecord(payslipId);
  // Phase 5: the payroll clerk is released at the durable enqueue; the
  // render + dispatch chain drains in the background and the print_jobs
  // rows carry the outcome.
  const ack = await PrintService.startPrintDocumentIntent({
    documentRecordId: ref.documentRecordId,
    scenario: 'payslip_issue',
    triggeredSource: 'manual',
    organizationId: ref.organizationId,
  });
  if (!ack.queued) throw new Error(ack.error ?? 'Failed to print payslip');
}
