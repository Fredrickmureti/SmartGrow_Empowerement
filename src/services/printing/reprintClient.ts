/**
 * reprintClient — governed reprint entry point (Track 4).
 *
 * Every document reprint MUST go through this client. It calls the
 * `request_reprint` RPC, which (a) requires a non-empty reason,
 * (b) verifies org access, (c) auto-approves for admin/owner and
 * leaves a pending request for everyone else, and (d) writes an
 * immutable audit row in `reprint_requests`.
 *
 * If the request is approved (immediately or later), call
 * `dispatchDocumentReprint`, which reprints through the normal document
 * pipeline with `isReprint = true` so the ledger row carries the flag.
 */

import { supabase } from '@/integrations/supabase/client';
import { printDocument } from '@/services/printing/PrintService';

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
 * Dispatch a reprint after request approval.
 *
 * A reprintable document goes through the same pipeline as its original
 * print — policy, ledger, render, dispatch — with the audit flag set, so
 * the reprint shows up in `print_jobs` as a distinct, reasoned event.
 */
export async function dispatchDocumentReprint(
  reprintRequestId: string,
  input: {
    sourceDocType: string;
    sourceDocId: string;
    organizationId: string;
    businessId?: string | null;
  },
) {
  return printDocument({
    documentType: input.sourceDocType,
    documentId: input.sourceDocId,
    organizationId: input.organizationId,
    businessId: input.businessId ?? null,
    correlationId: `reprint:${reprintRequestId}`,
    isReprint: true,
  });
}
