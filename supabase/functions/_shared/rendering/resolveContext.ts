/**
 * Build a `RenderContext` for a persisted document (Wave 3).
 *
 * Reads the canonical `documents` aggregate + branding rows. For inline
 * previews, callers use `contextFromPreview` instead.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { RenderContext, RenderRequest, AstBlock, RenderTheme } from "./types.ts";

const BUSINESS_COLS =
  "id, name, legal_name, logo_url, email, phone, address, city, state, postal_code, country, tax_id, registration_number, base_currency, timezone";

export async function buildContext(
  supabase: SupabaseClient,
  req: RenderRequest,
  themeId?: string | null,
  headerId?: string | null,
  footerId?: string | null,
): Promise<RenderContext> {
  const doc = req.document_id ? await loadDocument(supabase, req.document_id) : previewDocument(req);
  const business = doc.business_id
    ? (await supabase.from("businesses").select(BUSINESS_COLS).eq("id", doc.business_id).maybeSingle()).data
    : null;

  const [theme, header, footer] = await Promise.all([
    themeId ? loadTheme(supabase, themeId) : Promise.resolve(null),
    headerId ? loadHeaderFooter(supabase, headerId) : Promise.resolve(null),
    footerId ? loadHeaderFooter(supabase, footerId) : Promise.resolve(null),
  ]);

  return {
    document: doc,
    business,
    theme,
    header,
    footer,
    locale: (business as Record<string, string> | null)?.country ?? "US",
    options: normaliseOptions(req.options),
  };
}

/**
 * Option-key normalisation — the ONE place render knobs get canonicalised.
 *
 * Callers historically sent both `paper_format` (server/HTTP style) and
 * `paperFormat` (client style); renderers read one or the other, so an
 * explicit operator override could be silently dropped by casing alone.
 * Every alias is mirrored onto both spellings here so no renderer has to
 * know which side the value came from.
 */
const OPTION_ALIASES: Array<[snake: string, camel: string]> = [
  ["paper_format", "paperFormat"],
  ["render_mode", "renderMode"],
  ["force_render_mode", "forceRenderMode"],
  ["policy_id", "policyId"],
  ["rendered_by", "renderedBy"],
];

export function normaliseOptions(
  options: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(options ?? {}) };
  for (const [snake, camel] of OPTION_ALIASES) {
    const value = out[snake] ?? out[camel];
    if (value === undefined || value === null) continue;
    out[snake] = value;
    out[camel] = value;
  }
  return out;
}

async function loadDocument(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase.from("document_records").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`document_not_found:${id}`);
  return {
    id: data.id,
    kind_code: data.kind_code,
    organization_id: data.organization_id,
    business_id: data.business_id,
    branch_id: data.branch_id ?? null,
    // `document_records` stores the human-facing number in `document_number`.
    // Reading a non-existent `number` column silently blanked the artifact's
    // document_number, breaking artifact traceability for every kind.
    number: data.document_number ?? null,
    date: data.document_date ?? null,
    currency: data.currency ?? null,
    snapshot: (data.snapshot as Record<string, unknown>) ?? {},
  };
}

function previewDocument(req: RenderRequest) {
  if (!req.preview) throw new Error("render_request_missing_document_or_preview");
  return {
    id: "preview",
    kind_code: req.preview.kind_code,
    organization_id: req.preview.organization_id,
    business_id: req.preview.business_id,
    branch_id: req.preview.branch_id ?? null,
    number: (req.preview.snapshot["number"] as string) ?? null,
    date: (req.preview.snapshot["date"] as string) ?? null,
    currency: (req.preview.snapshot["currency"] as string) ?? null,
    snapshot: req.preview.snapshot,
  };
}

async function loadTheme(supabase: SupabaseClient, id: string): Promise<RenderTheme | null> {
  const { data } = await supabase.from("document_theme").select("*").eq("id", id).maybeSingle();
  if (!data) return null;
  return { id: data.id, tokens: (data.tokens as Record<string, string | number>) ?? {} };
}

async function loadHeaderFooter(
  supabase: SupabaseClient,
  id: string,
): Promise<{ ast: AstBlock[] } | null> {
  const { data } = await supabase.from("document_header_footer").select("*").eq("id", id).maybeSingle();
  if (!data) return null;
  return { ast: (data.ast as AstBlock[]) ?? [] };
}
