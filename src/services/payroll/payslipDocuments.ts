/**
 * Payslip documents — the one client-side payslip on-ramp.
 *
 * Every payslip surface calls this module. Downloads use the deployed
 * `generate-payslip-pdf` endpoint directly; printing continues through the
 * document ledger once a record has been materialised.
 */
import { supabase } from '@/integrations/supabase/client';
import { PrintService } from '@/services/printing/PrintService';
import { downloadPdfBlob } from '@/services/printing/pdfUtils';

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
 * The compatibility mode lives on the deployed payslip function. Do not call
 * the optional `ensure-payslip-document` function from the browser: projects
 * where it is absent fail at CORS preflight before application code can
 * provide a useful fallback.
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
  const payload = await invokeEnsure('generate-payslip-pdf', {
    payslip_id: payslipId,
    mode: 'ensure_document',
  });

  return {
    documentRecordId: String(payload.document_record_id),
    documentNumber: (payload.document_number as string | null) ?? null,
    filename: (payload.filename as string | undefined) ?? `payslip-${payslipId}`,
    organizationId: (payload.organization_id as string | null) ?? null,
    businessId: (payload.business_id as string | null) ?? null,
    branchId: (payload.branch_id as string | null) ?? null,
  };
}


/** Download a payslip from the deployed PDF endpoint. */
export async function downloadPayslipPdf(
  payslipId: string,
  opts?: { filename?: string },
): Promise<void> {
  const { data, error } = await supabase.functions.invoke('generate-payslip-pdf', {
    body: { payslip_id: payslipId },
  });
  if (error) throw new Error(error.message || 'Failed to generate payslip PDF');

  const blob = data instanceof Blob
    ? data
    : new Blob([data instanceof ArrayBuffer ? data : data], { type: 'application/pdf' });
  if (blob.size === 0) throw new Error('Generated payslip PDF was empty');

  const requestedName = opts?.filename ?? `payslip-${payslipId}.pdf`;
  downloadPdfBlob(blob, requestedName.toLowerCase().endsWith('.pdf') ? requestedName : `${requestedName}.pdf`);
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
