/**
 * reprintClient — governed reprint entry point (Track 4).
 *
 * Every reprint of a receipt / GRN label / shipping label / payslip /
 * asset tag MUST go through this client. It calls the
 * `request_reprint` RPC, which (a) requires a non-empty reason,
 * (b) verifies org access, (c) auto-approves for admin/owner and
 * leaves a pending request for everyone else, and (d) writes an
 * immutable audit row in `reprint_requests`.
 *
 * If the request is approved (immediately or later), call
 * `dispatchLabelReprint` / `dispatchReceiptReprint` to send the actual
 * hardware command — they forward through HardwareClient with
 * `isReprint = true` so the exec log row carries the audit flag.
 */

import { supabase } from '@/integrations/supabase/client';
import { hardwareClient } from '@/services/hardware/HardwareClient';
import { printClient } from '@/services/printing/PrintClient';
import type { LabelDispatchInput } from '@/services/printing/labelDispatch';
import { generateDocumentEscPosBytes } from '@/services/printing/pdfUtils';

export interface RequestReprintInput {
  orgId: string;
  branchId?: string | null;
  documentKind: string;
  sourceDocType: string;
  sourceDocId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export async function requestReprint(input: RequestReprintInput): Promise<
  { ok: true; requestId: string } | { ok: false; error: string }
> {
  if (!input.reason?.trim()) return { ok: false, error: 'a reason is required for reprint' };
  const { data, error } = await supabase.rpc('request_reprint', {
    p_org_id: input.orgId,
    p_branch_id: input.branchId ?? null,
    p_document_kind: input.documentKind,
    p_source_doc_type: input.sourceDocType,
    p_source_doc_id: input.sourceDocId,
    p_reason: input.reason.trim(),
    p_metadata: (input.metadata ?? {}) as never,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, requestId: String(data) };
}

/**
 * Dispatch a label reprint after request approval. Forces the
 * `isReprint` audit flag and uses a fresh idempotency key so the
 * reprint is not coalesced with the original print.
 */
export async function dispatchLabelReprint(
  reprintRequestId: string,
  input: Omit<LabelDispatchInput, 'idempotencyKey'>,
) {
  return printClient.printLabel({
    ...input,
    idempotencyKey: `reprint:${reprintRequestId}`,
  });
}

/**
 * Dispatch a receipt reprint via the receipt printer. Used for
 * transactional documents (invoices, payslips, POS receipts) that have
 * a rendered payload independent of the label-template registry.
 */
export async function dispatchReceiptReprint(
  reprintRequestId: string,
  input: { receiptData: unknown; sourceDocType: string; sourceDocId: string },
) {
  if (input.sourceDocType === 'pos_receipt') {
    const bytes = await generateDocumentEscPosBytes('pos_receipt', input.sourceDocId, {
      forceRefreshSettings: false,
    });
    return hardwareClient.exec({
      role: 'receipt_printer',
      op: 'print_raw',
      payload: Array.from(bytes),
      idempotencyKey: `reprint:${reprintRequestId}`,
      sourceDocType: input.sourceDocType,
      sourceDocId: input.sourceDocId,
      isReprint: true,
    });
  }

  return hardwareClient.exec({
    role: 'receipt_printer',
    op: 'print_receipt',
    payload: { receiptData: input.receiptData },
    idempotencyKey: `reprint:${reprintRequestId}`,
    sourceDocType: input.sourceDocType,
    sourceDocId: input.sourceDocId,
    isReprint: true,
  });
}
