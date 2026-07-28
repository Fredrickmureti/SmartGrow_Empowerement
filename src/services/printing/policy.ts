/**
 * printing/policy — the ONE print-policy resolver.
 *
 * Answers a single question for the pipeline: for this
 * (business, branch, document type) tuple, what paper format, render
 * mode and copy count did the operator configure, and should the job be
 * dispatched automatically?
 *
 * Physical device selection is NOT decided here — that is
 * `resolve_device` (see `dispatch.ts`). Policy is data about the
 * document; device binding is data about the hardware. Keeping them in
 * separate resolvers is what allows the same invoice policy to print on
 * different printers per branch without any document-type branching.
 *
 * Cached for 30s per key so a POS lane firing receipts back-to-back does
 * not hit the database on every click.
 */
import { supabase } from '@/integrations/supabase/client';

export interface ResolvedPrintPolicy {
  paperFormat: string;
  renderMode: 'pdf' | 'escpos' | 'html';
  copies: number;
  autoPrint: boolean;
  askUser: boolean;
}

const TTL_MS = 30_000;
const MAX_ENTRIES = 200;

interface Entry { value: ResolvedPrintPolicy | null; expiresAt: number }
const cache = new Map<string, Entry>();

function keyFor(businessId: string, branchId: string | null | undefined, documentType: string): string {
  return `${businessId}|${branchId ?? ''}|${documentType}`;
}

export function invalidatePolicyCache(): void {
  cache.clear();
}

export async function resolvePrintPolicy(
  businessId: string | null | undefined,
  branchId: string | null | undefined,
  documentType: string,
): Promise<ResolvedPrintPolicy | null> {
  if (!businessId) return null;
  const key = keyFor(businessId, branchId, documentType);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    cache.delete(key);
    cache.set(key, hit); // LRU touch
    return hit.value;
  }

  let value: ResolvedPrintPolicy | null = null;
  try {
    const { data, error } = await supabase
      .from('document_print_policies')
      .select('paper_format, render_mode, trigger, copies, branch_id')
      .eq('business_id', businessId)
      .eq('document_type', documentType)
      .or(branchId ? `branch_id.eq.${branchId},branch_id.is.null` : 'branch_id.is.null');
    if (error) return null;
    const rows = (data ?? []) as Array<{
      paper_format?: string | null;
      render_mode?: string | null;
      trigger?: string | null;
      copies?: number | null;
      branch_id?: string | null;
    }>;
    const row =
      (branchId ? rows.find((r) => r.branch_id === branchId) : null) ??
      rows.find((r) => r.branch_id === null) ??
      null;
    if (row) {
      const mode = (row.render_mode ?? 'pdf') as ResolvedPrintPolicy['renderMode'];
      const trigger = row.trigger ?? 'manual';
      value = {
        paperFormat: String(row.paper_format ?? 'a4'),
        renderMode: mode === 'escpos' || mode === 'html' ? mode : 'pdf',
        copies: typeof row.copies === 'number' && row.copies > 0 ? row.copies : 1,
        autoPrint: trigger === 'auto',
        askUser: trigger === 'preview_only',
      };
    }
  } catch {
    return null;
  }

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}
