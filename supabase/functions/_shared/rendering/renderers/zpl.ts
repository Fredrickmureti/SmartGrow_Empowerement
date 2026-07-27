/**
 * AST → ZPL adapter (Wave 3).
 *
 * Label templates live in `label_templates` (see ADR-0086) and MUST be
 * resolved by `resolve_label_template`. This adapter is deliberately
 * thin: it takes the AST-provided `template_key` (or falls back to the
 * document kind), resolves the label body via RPC, and does token
 * substitution using the document snapshot.
 *
 * Wave 8 will migrate label_templates into the unified template_ast
 * table with `media_class='label'`; until then this adapter bridges the
 * two registries so callers only see one entry point.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { AstBlock, RenderContext, ResolvedTemplate } from "../types.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function encoder() {
  return new TextEncoder();
}

function substitute(body: string, snap: Record<string, unknown>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
    const parts = String(key).split(".");
    let cur: unknown = snap;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        cur = "";
        break;
      }
    }
    return String(cur ?? "");
  });
}

export async function renderAstToZpl(args: {
  template: ResolvedTemplate;
  context: RenderContext;
  blocks: AstBlock[];
}): Promise<Uint8Array> {
  const opts = args.context.options as Record<string, unknown>;
  const templateKey = (opts["template_key"] as string | undefined) ?? args.context.document.kind_code;
  const { data, error } = await supabase.rpc("resolve_label_template", {
    p_org_id: args.context.document.organization_id,
    p_branch_id: args.context.document.branch_id,
    p_template_key: templateKey,
  });
  if (error) throw error;
  const body: string = (data as { body?: string } | null)?.body ?? "";
  if (!body) throw new Error(`label_template_not_found:${templateKey}`);
  const zpl = substitute(body, args.context.document.snapshot);
  return encoder().encode(zpl);
}
