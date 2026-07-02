/**
 * attendance-missed-checkout — scheduled cron job.
 *
 * Closes attendance sessions left open past their business's
 * `auto_checkout_after_hours`, and notifies the affected employee +
 * their manager(s).
 *
 * Trigger: pg_cron `net.http_post` every 15 minutes.
 *
 * Auth model: this is a cron-only function — it expects the project's
 * SERVICE_ROLE_KEY in the Authorization header (preferred) or the anon
 * key (acceptable since it only reads env to build a service client).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1. Identify stale open sessions BEFORE auto-checkout closes them
    // (so we can notify the right people).
    const { data: openSessions, error: openErr } = await supabase
      .from("attendance")
      .select(
        "id, organization_id, business_id, branch_id, employee_id, clock_in, " +
          "employee:employees(first_name, last_name, user_id, manager_id)",
      )
      .is("clock_out", null);
    if (openErr) throw openErr;

    // Per-business threshold lookup
    const businessIds = Array.from(
      new Set((openSessions || []).map((s: any) => s.business_id).filter(Boolean)),
    );
    const thresholds: Record<string, number> = {};
    if (businessIds.length) {
      const { data: settings } = await supabase
        .from("attendance_settings")
        .select("business_id, auto_checkout_after_hours")
        .in("business_id", businessIds);
      for (const s of settings || []) {
        thresholds[s.business_id as string] = (s as any).auto_checkout_after_hours ?? 16;
      }
    }

    const now = Date.now();
    const stale = (openSessions || []).filter((s: any) => {
      const h = thresholds[s.business_id] ?? 16;
      return now - new Date(s.clock_in).getTime() > h * 3600 * 1000;
    });

    if (stale.length === 0) {
      return json({ processed: 0, notified: 0, message: "no stale sessions" });
    }

    // 2. Run the DB-side auto-checkout RPC (closes them).
    const { data: closed, error: rpcErr } = await supabase.rpc("attendance_auto_checkout");
    if (rpcErr) console.warn("auto_checkout rpc:", rpcErr.message);

    // 3. Notify the employee + their manager(s).
    const notificationRows: any[] = [];
    for (const s of stale) {
      const emp = (s as any).employee || {};
      const empName = `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() || "Employee";
      const startedAt = new Date(s.clock_in).toISOString();
      const baseRow = {
        organization_id: s.organization_id,
        business_id: s.business_id,
        type: "in_app",
        category: "attendance",
        title: "Missed checkout — session auto-closed",
        message: `${empName} did not clock out. The session that started at ${startedAt} was auto-closed.`,
        link: "/hr/attendance",
        entity_type: "attendance",
        entity_id: s.id,
        priority: "normal",
      };
      if (emp.user_id) {
        notificationRows.push({
          ...baseRow,
          user_id: emp.user_id,
          link: "/me/attendance",
          message: `Your session that started at ${startedAt} was auto-closed because no checkout was recorded.`,
        });
      }
      if (emp.manager_id) {
        // Resolve manager → user_id
        const { data: mgr } = await supabase
          .from("employees")
          .select("user_id")
          .eq("id", emp.manager_id)
          .maybeSingle();
        if (mgr?.user_id) {
          notificationRows.push({ ...baseRow, user_id: mgr.user_id });
        }
      }
    }

    let notified = 0;
    if (notificationRows.length) {
      const { error: nErr } = await supabase.from("notifications").insert(notificationRows);
      if (nErr) console.warn("notifications insert:", nErr.message);
      else notified = notificationRows.length;
    }

    return json({ processed: closed ?? stale.length, notified, stale_count: stale.length });
  } catch (e) {
    console.error("attendance-missed-checkout error:", e);
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
