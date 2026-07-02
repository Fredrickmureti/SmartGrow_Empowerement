/**
 * Token-graph impact analyser for localization-pack reference rows.
 *
 * Given a tax / account / remittance row that an admin is about to delete,
 * this returns the set of `pack_token_registry` entries and template bodies
 * that reference it so the UI can warn (and require confirm-text) before
 * silently breaking payslip / certificate / return rendering.
 *
 * Pure (no React) so it's trivially testable in vitest.
 */
import { supabase } from "@/integrations/supabase/client";
import type { PackToken } from "../types";
import { extractTokens } from "./extractTokens";

export type ReferenceKind = "tax" | "account" | "remittance";

export interface ReferenceRowKey {
  /** For tax rows: `name`. For account rows: `code`. For remittance: `rule_code`. */
  key: string;
}

export interface TemplateImpact {
  table: "localization_pack_certificate_templates" | "localization_pack_return_templates";
  code: string;
  display_name: string | null;
  matchedTokens: string[];
}

export interface ImpactResult {
  tokens: PackToken[];
  templates: TemplateImpact[];
  empty: boolean;
}

/**
 * Decide whether a token references a given reference row. Match strategy
 * is intentionally loose (prefix + segment) to catch the common conventions
 * we see in seeded packs without producing false negatives:
 *
 *   tax row "vat"        ⇒ `tax.vat.*`, `tax_template:vat`
 *   account row "2100"   ⇒ `account.2100.*`, `gl.2100.*`
 *   remittance "kra_paye"⇒ `remittance.kra_paye.*`
 */
export function tokenReferencesRow(tokenPath: string, kind: ReferenceKind, key: string): boolean {
  if (!key) return false;
  const k = key.toLowerCase();
  const path = tokenPath.toLowerCase();
  switch (kind) {
    case "tax":
      return path.startsWith(`tax.${k}.`) || path === `tax.${k}` || path.includes(`tax_template:${k}`);
    case "account":
      return path.startsWith(`account.${k}.`) || path.startsWith(`gl.${k}.`) || path === `account.${k}` || path === `gl.${k}`;
    case "remittance":
      return path.startsWith(`remittance.${k}.`) || path === `remittance.${k}`;
  }
}

/**
 * Match a single template body against a reference row. We extract every
 * `{{token}}` reference from the body and apply `tokenReferencesRow` so the
 * heuristic stays in one place.
 */
export function templateReferencesRow(body: any, kind: ReferenceKind, key: string): string[] {
  const tokens = Array.from(extractTokens(body));
  return tokens.filter((t) => tokenReferencesRow(t, kind, key));
}

export async function analyzeReferenceDelete(input: {
  packId: string;
  kind: ReferenceKind;
  key: string;
}): Promise<ImpactResult> {
  const { packId, kind, key } = input;
  if (!key) return { tokens: [], templates: [], empty: true };

  const [{ data: tokenRows }, { data: certRows }, { data: returnRows }] = await Promise.all([
    (supabase as any).from("pack_token_registry").select("*").or(`pack_id.is.null,pack_id.eq.${packId}`),
    (supabase as any).from("localization_pack_certificate_templates").select("code,display_name,body").eq("pack_id", packId),
    (supabase as any).from("localization_pack_return_templates").select("code,display_name,body").eq("pack_id", packId),
  ]);

  const tokens = ((tokenRows ?? []) as PackToken[]).filter((t) => tokenReferencesRow(t.token_path, kind, key));

  const templates: TemplateImpact[] = [];
  for (const r of (certRows ?? [])) {
    const matched = templateReferencesRow(r.body, kind, key);
    if (matched.length) {
      templates.push({
        table: "localization_pack_certificate_templates",
        code: r.code, display_name: r.display_name ?? null, matchedTokens: matched,
      });
    }
  }
  for (const r of (returnRows ?? [])) {
    const matched = templateReferencesRow(r.body, kind, key);
    if (matched.length) {
      templates.push({
        table: "localization_pack_return_templates",
        code: r.code, display_name: r.display_name ?? null, matchedTokens: matched,
      });
    }
  }

  return { tokens, templates, empty: tokens.length === 0 && templates.length === 0 };
}
