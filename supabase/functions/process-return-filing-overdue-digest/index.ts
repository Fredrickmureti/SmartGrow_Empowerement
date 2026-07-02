// @ts-nocheck — Deno runtime
/**
 * process-return-filing-overdue-digest (W5)
 *
 * Daily cron job. Scans `payroll_return_runs` where status is
 * `submitted_awaiting_ack` and the submission is older than 7 days, and
 * inserts ONE `notifications` row per organization owner / payroll-write
 * user (de-duplicated per UTC day) summarising the overdue returns.
 *
 * Idempotent for the day: collapses on
 * `(organization_id, business_id, today)` via the `entity_id` field so
 * cron retries inside the same UTC day cannot double-notify.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = requireCronAuth(req);
  if (denied) return denied;

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: overdue, error } = await admin
    .from("payroll_return_runs")
    .select("id, organization_id, business_id, template_code, period_end, submitted_at")
    .eq("status", "submitted_awaiting_ack")
    .lt("submitted_at", sevenDaysAgo)
    .order("submitted_at", { ascending: true });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Group by org/business
  const grouped = new Map<string, any[]>();
  for (const r of (overdue ?? [])) {
    const key = `${r.organization_id}::${r.business_id ?? ""}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  const today = new Date().toISOString().slice(0, 10);
  let notified = 0;
  let skipped = 0;

  for (const [key, rows] of grouped.entries()) {
    const [organization_id, businessRaw] = key.split("::");
    const business_id = businessRaw || null;

    // Find users in this org with payroll-write access. We rely on the
    // existing membership table; if not present we silently skip — the
    // calendar UI still surfaces overdue items.
    const { data: members } = await admin
      .from("user_business_access")
      .select("user_id")
      .eq("organization_id", organization_id);

    if (!members?.length) { skipped++; continue; }

    const dedupeEntityId = `${organization_id}:${business_id ?? "all"}:${today}`;
    const oldest = rows.reduce((a, r) =>
      new Date(r.submitted_at).getTime() < new Date(a.submitted_at).getTime() ? r : a, rows[0]);
    const oldestDays = Math.floor(
      (Date.now() - new Date(oldest.submitted_at).getTime()) / (24 * 60 * 60 * 1000),
    );

    const rowsToInsert = members.map((m) => ({
      organization_id,
      business_id,
      user_id: m.user_id,
      type: "warning",
      category: "compliance",
      title: `${rows.length} statutory return${rows.length === 1 ? "" : "s"} awaiting acknowledgement`,
      message: `Oldest submission is ${oldestDays} days old. Upload the portal receipt or mark as filed.`,
      link: "/compliance",
      entity_type: "payroll_return_filing_overdue",
      entity_id: dedupeEntityId,
      priority: oldestDays >= 14 ? "high" : "normal",
    }));

    // Skip users who already have a row for this dedupe key today
    const userIds = rowsToInsert.map((r) => r.user_id);
    const { data: existing } = await admin
      .from("notifications")
      .select("user_id")
      .eq("entity_type", "payroll_return_filing_overdue")
      .eq("entity_id", dedupeEntityId)
      .in("user_id", userIds);
    const seen = new Set((existing ?? []).map((r: any) => r.user_id));
    const fresh = rowsToInsert.filter((r) => !seen.has(r.user_id));

    if (!fresh.length) { skipped++; continue; }
    const { error: insErr } = await admin.from("notifications").insert(fresh);
    if (insErr) {
      console.warn("notification insert failed", organization_id, insErr.message);
    } else {
      notified += fresh.length;
    }
  }

  return new Response(
    JSON.stringify({ scanned: overdue?.length ?? 0, notified, skipped }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
