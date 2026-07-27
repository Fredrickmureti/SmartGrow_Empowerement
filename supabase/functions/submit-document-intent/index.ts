/**
 * Wave 5 — submit-document-intent edge function.
 *
 * POST /submit-document-intent
 * Body: {
 *   document_record_id: string,
 *   scenario?: string,               // default 'default'
 *   triggered_source?: 'business_event' | 'manual' | 'reprint' | 'api'
 * }
 *
 * The single server-side chokepoint for dispatching a document. Resolves the
 * Wave 4 output intent, enqueues one job per target in `print_jobs`, and
 * returns the job ids. Callers never render bytes or route to hardware
 * themselves — downstream workers consume `print_jobs` rows.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { requireOrgMember } from "../_shared/requireOrgMember.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: {
    document_record_id?: string;
    scenario?: string | null;
    triggered_source?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (!body?.document_record_id) {
    return json({ error: "missing_document_record_id" }, 400);
  }

  const service = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Lookup org for auth gating.
  const { data: doc, error: docErr } = await service
    .from("document_records")
    .select("organization_id")
    .eq("id", body.document_record_id)
    .maybeSingle();
  if (docErr) return json({ error: "lookup_failed", detail: docErr.message }, 500);
  if (!doc) return json({ error: "document_record_not_found" }, 404);

  const gate = await requireOrgMember(req, doc.organization_id, corsHeaders);
  if (!gate.ok) return gate.response;

  const { data, error } = await service.rpc("submit_document_intent", {
    p_document_record_id: body.document_record_id,
    p_scenario: body.scenario ?? "default",
    p_triggered_source: body.triggered_source ?? "api",
    p_override_targets: null,
  });

  if (error) return json({ error: "submit_failed", detail: error.message }, 500);
  return json(data, 200);
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
