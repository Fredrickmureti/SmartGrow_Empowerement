/**
 * Label-template adapter for the `format=zpl` branch of `generate-document`.
 *
 * Architecture (ADR-0086, drift item D1):
 *   Business event → canonical document model → canonical layout engine
 *   → output renderer → hardware driver.
 *
 * For labels, the canonical layout engine is the `label_templates` table.
 * Every label body — product, shelf-edge, GRN summary, transfer manifest,
 * shipping, and now `inventory_label` — lives there under an
 * (org_id, template_key) key and is resolved via `resolve_label_template`
 * with a branch → org fallback chain. The client path
 * (`src/services/printing/labelDispatch.ts::printLabelByTemplate`) already
 * consumes this pipeline; this file is the server-side equivalent for the
 * generate-document `format=zpl` branch.
 *
 * This file used to hardcode ZPL bodies for `inventory_label` and
 * `shipping_label`, which duplicated the label engine on two paths and
 * meant a branch override in `label_templates` was silently ignored by
 * server renders. That parallel implementation is the exact class of
 * drift ADR-0084/0085 corrected for receipts; the fix is to make this
 * file a thin resolver that reads the same rows the client does.
 *
 * Guardrail: `src/test/architecture/label-builder-has-no-hardcoded-zpl.test.ts`
 * asserts that this file contains no `^XA`/`^XZ` string literal — all
 * ZPL bodies must originate in `label_templates`.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

/** Supported document types for the ZPL branch. Extend by adding a
 *  matching `label_templates` row (template_key = documentType) and, if
 *  the label needs data lookups, a `fetchVars` case below. */
const SUPPORTED_DOCUMENT_TYPES = new Set(['inventory_label', 'shipping_label']);

/** Sanitise a token value before injecting it into a ZPL body. ZPL is
 *  ASCII-only on the wire; a raw UTF-8 byte inside `^FD…^FS` can brick
 *  the label. The client-side dispatcher applies the same rule when it
 *  encodes bytes. Cap length to keep long product names from overrunning
 *  the label envelope. */
function asciiSafe(v: unknown, max = 64): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, max);
}

/** `{{token}}` substitution — whitespace tolerated, missing keys render
 *  as empty. Mirrors `renderTemplateBody` in
 *  `src/services/printing/labelDispatch.ts`. Kept as a duplicated helper
 *  because Deno edge functions cannot import from `src/`; the parity
 *  test at `src/test/printing/label-template-substitution-parity.test.ts`
 *  locks the two implementations byte-for-byte. */
function renderTemplateBody(body: string, vars: Record<string, unknown>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) =>
    asciiSafe(vars[key], 64),
  );
}

interface ResolvedTemplate {
  id: string;
  engine: 'zpl' | 'epl' | 'escpos' | 'pdf';
  body: string;
  version: number;
  kind: string;
  scope: string;
}

async function resolveTemplate(
  supabase: SupabaseClient,
  orgId: string | null,
  templateKey: string,
): Promise<ResolvedTemplate | null> {
  const { data, error } = await supabase.rpc('resolve_label_template', {
    p_org_id: orgId,
    p_template_key: templateKey,
    p_branch_id: null,
  });
  if (error || !data) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as ResolvedTemplate | null;
}

/** Per-document variable resolution. Keep every branch DATA-only — no
 *  layout, no ZPL, no dot offsets. Layout lives in `label_templates`. */
async function fetchVars(
  supabase: SupabaseClient,
  documentType: string,
  documentId: string,
): Promise<{ orgId: string | null; vars: Record<string, unknown> }> {
  if (documentType === 'inventory_label') {
    try {
      // Only columns known to exist on `products` today. Barcode lives
      // in `product_identifiers` and is joined lazily below; retail
      // pricing lives elsewhere per branch. Layout is defined by the
      // label_templates row — this branch resolves DATA only.
      const { data } = await supabase
        .from('products')
        .select('id, sku, name, unit_price, organization_id')
        .eq('id', documentId)
        .maybeSingle();
      if (data) {
        const sku = (data as { sku?: string | null }).sku ?? documentId;
        const p = (data as { unit_price?: number | null }).unit_price;
        const price = typeof p === 'number' ? p.toFixed(2) : '';
        return {
          orgId: (data as { organization_id?: string | null }).organization_id ?? null,
          vars: {
            sku,
            name: (data as { name?: string }).name ?? documentId,
            barcode: sku,
            price,
          },
        };
      }
    } catch {
      /* fall through to id-only stub */
    }
    return { orgId: null, vars: { sku: documentId, name: documentId, barcode: documentId, price: '' } };
  }

  if (documentType === 'shipping_label') {
    // The shipping_label template body references
    // {{deliveryNoteId}}, {{customer_name}}, {{customer_address}}.
    // A follow-up will join delivery_notes → contacts for the customer
    // fields; today the client path passes them explicitly via
    // printLabelByTemplate, so the server branch stays deliveryNoteId-only.
    return { orgId: null, vars: { deliveryNoteId: documentId, customer_name: '', customer_address: '' } };
  }

  return { orgId: null, vars: {} };
}

/**
 * Resolve the label template for `documentType`, substitute vars, and
 * return the on-wire bytes. Throws with a descriptive message when the
 * document type is unsupported or no template is registered for the
 * resolved organization — the caller (generate-document) turns the throw
 * into a 400 with the error body intact.
 */
export async function buildLabelZpl(
  supabase: SupabaseClient,
  documentType: string,
  documentId: string,
): Promise<Uint8Array> {
  if (!SUPPORTED_DOCUMENT_TYPES.has(documentType)) {
    throw new Error(`ZPL renderer does not support document type "${documentType}"`);
  }

  const { orgId, vars } = await fetchVars(supabase, documentType, documentId);
  const tpl = await resolveTemplate(supabase, orgId, documentType);
  if (!tpl) {
    throw new Error(
      `no label template registered for key '${documentType}' (org=${orgId ?? 'unknown'}). ` +
      `Seed it via seed_default_label_templates or the label editor.`,
    );
  }
  if (tpl.engine !== 'zpl') {
    throw new Error(
      `label template '${documentType}' is engine=${tpl.engine}, not zpl. ` +
      `The ZPL branch of generate-document only handles zpl-engine templates.`,
    );
  }

  const rendered = renderTemplateBody(tpl.body, vars);
  return new TextEncoder().encode(rendered);
}
