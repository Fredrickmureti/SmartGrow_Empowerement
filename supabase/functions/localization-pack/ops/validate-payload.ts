/**
 * validate-localization-payload
 * Authoritative pre-save validation of a localization-pack payload
 * (statutory rule parameters or template body) against the JSON Schema
 * registry in `pack_rule_type_schemas` and the token registry in
 * `pack_token_registry`. Used by both the platform editor and the
 * tenant editor before write.
 *
 * Body:
 *   { kind: 'rule', rule_type, parameters }
 *   { kind: 'template', pack_id, body }
 *
 * Returns: { valid: boolean, errors: string[], warnings: string[] }
 */
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { validateAgainstSchema, extractTokens } from "../../_shared/validateAgainstSchema.ts";
import { validateReturnTemplateBody } from "../../_shared/returnTemplateSchema.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type ValidationResult = { valid: boolean; errors: string[]; warnings: string[] };

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Validator + token extractor live in `_shared/validateAgainstSchema.ts`
// so the same code path runs under vitest + Node and under Deno here.

export async function run(req: Request): Promise<Response> {

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const body = await req.json();
    const result: ValidationResult = { valid: true, errors: [], warnings: [] };

    if (body.kind === "rule") {
      const { rule_type, parameters } = body;
      if (!rule_type || !parameters) {
        return ok({ valid: false, errors: ["rule_type and parameters required"], warnings: [] }, 400);
      }
      const kind = parameters?.type ?? "unknown";
      const { data: schemaRow } = await sb
        .from("pack_rule_type_schemas")
        .select("json_schema")
        .eq("rule_type", rule_type)
        .eq("computation_kind", kind)
        .order("schema_version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!schemaRow) {
        // Hard fail — every rule_type/computation_kind must have a registered
        // JSON Schema before it can be published. The previous behaviour of
        // accepting `legacy_unvalidated` was a bootstrapping escape hatch and
        // is no longer allowed for new pack content.
        result.valid = false;
        result.errors.push(
          `No JSON Schema registered for ${rule_type}/${kind}. ` +
          `Register one in pack_rule_type_schemas before publishing this rule.`,
        );
      } else {
        result.errors = validateAgainstSchema(parameters, schemaRow.json_schema);
        result.valid = result.errors.length === 0;
      }
      return ok(result);
    }

    if (body.kind === "template") {
      const { pack_id, body: templateBody } = body;
      if (!templateBody) return ok({ valid: false, errors: ["body required"], warnings: [] }, 400);
      const tokens = Array.from(extractTokens(templateBody));
      const { data: registry } = await sb
        .from("pack_token_registry")
        .select("token_path, deprecated_in_version, replaces")
        .or(`pack_id.is.null${pack_id ? `,pack_id.eq.${pack_id}` : ""}`);
      const allowed = new Map<string, any>((registry ?? []).map((r: any) => [r.token_path, r]));
      for (const t of tokens) {
        const reg = allowed.get(t);
        if (!reg) result.errors.push(`Unknown token {{${t}}} — not found in token registry`);
        else if (reg.deprecated_in_version) result.warnings.push(`{{${t}}} deprecated in ${reg.deprecated_in_version}; use ${reg.replaces ?? "registered replacement"}`);
      }
      result.valid = result.errors.length === 0;
      return ok(result);
    }

    if (body.kind === "return_template") {
      const { body: tplBody } = body;
      if (!tplBody) return ok({ valid: false, errors: ["body required"], warnings: [] }, 400);
      const { errors, warnings } = validateReturnTemplateBody(tplBody);
      result.errors = errors;
      result.warnings = warnings;
      result.valid = errors.length === 0;
      return ok(result);
    }

    return ok({ valid: false, errors: ["kind must be 'rule' | 'template' | 'return_template'"], warnings: [] }, 400);
  } catch (e) {
    return ok({ valid: false, errors: [String(e?.message ?? e)], warnings: [] }, 500);
  }

}

