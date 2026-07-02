/**
 * filing-calendar-reconcile — idempotent nightly reconciler for the
 * `payroll_filing_calendar_projection`.
 *
 * Walks every business that has any installed localization pack and
 * calls `refresh_filing_calendar_business(business_id)` — the sole
 * writer of the projection. Guarantees that even if an outbox event
 * was lost or the projection was manually corrupted, the calendar
 * self-heals within 24h.
 *
 * Runs unauthenticated (invoked by pg_cron via HTTP). The RPC it
 * calls is service_role-only, so no elevation happens client-side.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { data: installs, error } = await admin
      .from("installed_localization_packs")
      .select("business_id")
      .eq("status", "installed");
    if (error) throw error;
    const businessIds = Array.from(
      new Set((installs ?? []).map((r: any) => r.business_id).filter(Boolean)),
    );
    let refreshed = 0;
    const errors: Array<{ business_id: string; error: string }> = [];
    for (const businessId of businessIds) {
      const { error: rpcErr } = await admin.rpc("refresh_filing_calendar_business", {
        _business_id: businessId,
      });
      if (rpcErr) {
        errors.push({ business_id: businessId, error: rpcErr.message });
      } else {
        refreshed++;
      }
    }
    return new Response(JSON.stringify({ refreshed, total: businessIds.length, errors }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});