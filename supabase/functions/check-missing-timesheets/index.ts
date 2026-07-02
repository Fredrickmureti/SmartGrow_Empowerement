// Weekly cron: notify active employees who did NOT submit a timesheet for last week.
// Idempotent: skips employees who already received a missing-week reminder for that period.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function lastWeekRange(now = new Date()): { start: string; end: string } {
  // ISO Monday-Sunday week immediately preceding `now`
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  // Move to last Monday
  d.setUTCDate(d.getUTCDate() - day - 6);
  const start = new Date(d);
  const end = new Date(d);
  end.setUTCDate(end.getUTCDate() + 6);
  const fmt = (x: Date) => x.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { start, end } = lastWeekRange();

    // 1. Active employees with a linked user_id (only those can receive in-app notifications)
    const { data: employees, error: empErr } = await supabase
      .from("employees")
      .select("id, user_id, organization_id, business_id, first_name, last_name")
      .eq("is_active", true)
      .not("user_id", "is", null);
    if (empErr) throw empErr;

    if (!employees || employees.length === 0) {
      return new Response(JSON.stringify({ ok: true, notified: 0, period: { start, end } }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const empIds = employees.map((e) => e.id);

    // 2. Submissions covering last week
    const { data: subs, error: subErr } = await supabase
      .from("timesheet_submissions")
      .select("employee_id")
      .in("employee_id", empIds)
      .lte("period_start", end)
      .gte("period_end", start);
    if (subErr) throw subErr;
    const submitted = new Set((subs ?? []).map((s) => s.employee_id));

    // 3. Already-sent reminders (idempotency)
    const { data: existing, error: existErr } = await supabase
      .from("notifications")
      .select("user_id")
      .eq("type", "timesheet_missing_week")
      .eq("entity_type", "timesheet_period")
      .gte("created_at", new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
    if (existErr) throw existErr;
    const alreadyNotified = new Set((existing ?? []).map((n) => n.user_id));

    const rows = employees
      .filter((e) => !submitted.has(e.id) && !alreadyNotified.has(e.user_id))
      .map((e) => ({
        organization_id: e.organization_id,
        business_id: e.business_id,
        user_id: e.user_id,
        type: "timesheet_missing_week",
        category: "hr",
        title: "Timesheet missing",
        message: `You haven't submitted your timesheet for ${start} – ${end}.`,
        link: "/timesheets",
        entity_type: "timesheet_period",
        priority: 2,
      }));

    if (rows.length === 0) {
      return new Response(JSON.stringify({ ok: true, notified: 0, period: { start, end } }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: insErr } = await supabase.from("notifications").insert(rows);
    if (insErr) throw insErr;

    return new Response(
      JSON.stringify({ ok: true, notified: rows.length, period: { start, end } }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[check-missing-timesheets]", e);
    return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});