// @ts-nocheck — Deno runtime
/**
 * override-return-diagnostic (Slice D)
 *
 * Resolves a blocking `payroll_return_diagnostics` row with a justification.
 * Stamps the run's reconciliation_status to 'overridden' when the diagnostic
 * code is RETURN_RECONCILIATION_BREACH, so the submission-gate trigger
 * stops blocking. Justification is required and written to the filing event
 * ledger for audit (ADR-0036 — every override is recoverable).
 *
 * Body: { diagnostic_id: string, reason: string (>= 10 chars) }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthenticated" }, 401);

    const body = await req.json();
    if (!body?.diagnostic_id) return json({ error: "diagnostic_id required" }, 400);
    if (!body?.reason || String(body.reason).trim().length < 10) {
      return json({ error: "reason of at least 10 characters required" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: diag, error: dErr } = await admin
      .from("payroll_return_diagnostics")
      .select("*")
      .eq("id", body.diagnostic_id)
      .maybeSingle();
    if (dErr || !diag) return json({ error: "diagnostic not found" }, 404);

    const { data: perm } = await admin.rpc("user_has_module_permission", {
      _user_id: user.id,
      _org_id: diag.organization_id,
      _module: "financials",
      _operation: "write",
    });
    if (!perm) return json({ error: "permission denied" }, 403);

    const nowIso = new Date().toISOString();
    await admin
      .from("payroll_return_diagnostics")
      .update({ resolved_at: nowIso, resolved_by: user.id, resolution_note: body.reason })
      .eq("id", diag.id);

    if (diag.code === "RETURN_RECONCILIATION_BREACH") {
      await admin
        .from("payroll_return_runs")
        .update({
          reconciliation_status: "overridden",
          reconciliation_override_reason: body.reason,
          reconciliation_override_by: user.id,
          reconciliation_override_at: nowIso,
        })
        .eq("id", diag.run_id);
    }

    await admin.from("payroll_return_filing_events").insert({
      run_id: diag.run_id,
      organization_id: diag.organization_id,
      business_id: diag.business_id,
      event: "diagnostic_overridden",
      actor_id: user.id,
      payload: { diagnostic_id: diag.id, code: diag.code, reason: body.reason },
    });

    return json({ ok: true });
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
});
