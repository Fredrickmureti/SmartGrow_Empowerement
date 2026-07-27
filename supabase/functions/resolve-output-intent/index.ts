/**
 * Wave 4 — Output Intent Resolver
 *
 * POST /resolve-output-intent
 * Body: {
 *   document_kind: string,           // required, matches document_kinds.code
 *   organization_id: string,         // required
 *   branch_id?: string | null,
 *   scenario?: string,               // default 'default'
 *   document_id?: string | null,     // optional, for dispatch log linkage
 *   triggered_source?: string        // 'business_event' | 'manual' | 'reprint' | 'api'
 * }
 *
 * Returns the resolved output intent along with its ordered targets. This
 * function ONLY decides *where* rendered bytes should go — it never renders
 * or dispatches. Callers (rendering engine, print pipeline, email pipeline)
 * consume its output.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { requireOrgMember } from "../_shared/requireOrgMember.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ResolveRequest {
  document_kind: string;
  organization_id: string;
  branch_id?: string | null;
  scenario?: string | null;
  document_id?: string | null;
  triggered_source?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body: ResolveRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (!body?.document_kind || !body?.organization_id) {
    return json({ error: "missing_required_fields" }, 400);
  }

  const gate = await requireOrgMember(req, body.organization_id, corsHeaders);
  if (!gate.ok) return gate.response;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const scenario = body.scenario ?? "default";

  const { data, error } = await supabase.rpc("resolve_output_intent", {
    p_document_kind: body.document_kind,
    p_organization_id: body.organization_id,
    p_branch_id: body.branch_id ?? null,
    p_scenario: scenario,
  });

  if (error) {
    return json({ error: "resolver_failed", detail: error.message }, 500);
  }

  const resolved = data as {
    resolved: boolean;
    intent_id?: string;
    intent_name?: string;
    scope?: string;
    scenario?: string;
    targets?: unknown[];
    reason?: string;
  };

  // Best-effort dispatch log (never blocks the response).
  try {
    await supabase.from("output_dispatch_log").insert({
      document_id: body.document_id ?? null,
      document_kind: body.document_kind,
      organization_id: body.organization_id,
      branch_id: body.branch_id ?? null,
      scenario,
      intent_id: resolved?.intent_id ?? null,
      resolved_targets: resolved?.targets ?? [],
      triggered_by: gate.userId,
      triggered_source: body.triggered_source ?? "api",
      status: resolved?.resolved ? "resolved" : "failed",
      error: resolved?.resolved ? null : (resolved?.reason ?? "unresolved"),
    });
  } catch (_e) {
    // swallow — the log is advisory
  }

  return json(resolved, resolved?.resolved ? 200 : 404);
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
