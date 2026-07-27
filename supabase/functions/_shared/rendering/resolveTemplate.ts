/**
 * Template resolution — scope precedence (Wave 3, ADR-0084).
 *
 *   branch  >  organization  >  tenant  >  system
 *
 * Only `is_active AND is_default` rows are candidates at each scope.
 * Explicit `template_id` overrides the whole ladder. This is the ONLY
 * approved way to load a `document_template_ast` row for rendering.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { ResolvedTemplate } from "./types.ts";

interface ResolveArgs {
  kindCode: string;
  organizationId: string;
  branchId?: string | null;
  templateId?: string | null;
}

export async function resolveTemplateAst(
  supabase: SupabaseClient,
  args: ResolveArgs,
): Promise<ResolvedTemplate> {
  if (args.templateId) {
    const { data, error } = await supabase
      .from("document_template_ast")
      .select("*")
      .eq("id", args.templateId)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`template_not_found:${args.templateId}`);
    return normalise(data);
  }

  const ladder: Array<{
    scope: "branch" | "organization" | "tenant" | "system";
    match: Record<string, unknown>;
  }> = [];
  if (args.branchId) {
    ladder.push({
      scope: "branch",
      match: { scope: "branch", organization_id: args.organizationId, branch_id: args.branchId },
    });
  }
  ladder.push({
    scope: "organization",
    match: { scope: "organization", organization_id: args.organizationId },
  });
  ladder.push({ scope: "tenant", match: { scope: "tenant" } });
  ladder.push({ scope: "system", match: { scope: "system" } });

  for (const step of ladder) {
    let q = supabase
      .from("document_template_ast")
      .select("*")
      .eq("kind_code", args.kindCode)
      .eq("is_active", true)
      .eq("is_default", true);
    for (const [k, v] of Object.entries(step.match)) {
      q = q.eq(k, v as string);
    }
    const { data, error } = await q.limit(1).maybeSingle();
    if (error) throw error;
    if (data) return normalise(data);
  }

  throw new Error(`template_ast_not_found:${args.kindCode}`);
}

function normalise(row: Record<string, unknown>): ResolvedTemplate {
  return {
    id: row.id as string,
    kind_code: row.kind_code as string,
    scope: row.scope as ResolvedTemplate["scope"],
    version: (row.version as number) ?? 1,
    label: row.label as string,
    ast: row.ast as ResolvedTemplate["ast"],
    theme_id: (row.theme_id as string | null) ?? null,
    header_id: (row.header_id as string | null) ?? null,
    footer_id: (row.footer_id as string | null) ?? null,
    media_class: (row.media_class as ResolvedTemplate["media_class"]) ??
      ((row.ast as { media_class?: ResolvedTemplate["media_class"] }).media_class ?? "a4"),
  };
}
