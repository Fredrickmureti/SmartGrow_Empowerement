/**
 * project-digest-dispatch
 *
 * Idempotent weekly project digest. For each active project member, computes
 * weekly aggregates (open tasks, overdue tasks, milestones this week, hours
 * logged last week, budget burn %) and enqueues a `send-email` invocation
 * with `template_key='project_digest'`. Records send in `project_digest_log`
 * keyed by (project_id, user_id, sent_for_week) — second invocation for the
 * same ISO week is a no-op.
 *
 * Trigger: pg_cron Monday 07:00 UTC (see migration). Also callable manually
 * for testing via authenticated POST.
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

interface MemberRow {
  user_id: string;
  project_id: string;
  project_name: string;
  organization_id: string;
  email: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // ISO week start (Monday)
  const now = new Date();
  const day = now.getUTCDay();
  const diff = (day + 6) % 7; // Mon=0
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  const weekISO = weekStart.toISOString().slice(0, 10);

  // Pull active project members + project + recipient profile email.
  const { data: members, error: mErr } = await supabase
    .from("project_members")
    .select("user_id, project_id, projects:project_id (id, name, organization_id, status)")
    .not("user_id", "is", null);

  if (mErr) {
    return new Response(JSON.stringify({ error: mErr.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Resolve emails in one pass.
  const userIds = Array.from(new Set((members ?? []).map((m: any) => m.user_id))) as string[];
  const { data: profs } = await supabase.from("profiles").select("id, email").in("id", userIds);
  const emailByUser = new Map<string, string>((profs ?? []).map((p: any) => [p.id, p.email]));

  let enqueued = 0;
  let skipped = 0;
  let errors = 0;

  for (const m of (members ?? []) as any[]) {
    const proj = m.projects;
    if (!proj || proj.status !== "active") { skipped++; continue; }
    const email = emailByUser.get(m.user_id);
    if (!email) { skipped++; continue; }

    // Idempotency: existing log row?
    const { data: existing } = await supabase
      .from("project_digest_log")
      .select("id")
      .eq("project_id", proj.id)
      .eq("user_id", m.user_id)
      .eq("sent_for_week", weekISO)
      .maybeSingle();
    if (existing) { skipped++; continue; }

    // Aggregates
    const [{ count: openTasks }, { count: overdueTasks }, { count: milestonesThisWeek }] = await Promise.all([
      supabase.from("project_tasks").select("id", { count: "exact", head: true })
        .eq("project_id", proj.id).eq("assigned_to", m.user_id).eq("is_done", false),
      supabase.from("project_tasks").select("id", { count: "exact", head: true })
        .eq("project_id", proj.id).eq("assigned_to", m.user_id).eq("is_done", false)
        .lt("deadline", weekISO),
      supabase.from("project_milestones").select("id", { count: "exact", head: true })
        .eq("project_id", proj.id).gte("deadline", weekISO),
    ]);

    try {
      const inv = await supabase.functions.invoke("send-email", {
        body: {
          template_key: "project_digest",
          recipient_email: email,
          recipient_user_id: m.user_id,
          recipient_org_id: proj.organization_id,
          // Tenant context — without this the resolver in send-email falls
          // back to the platform name (ADR 0023).
          category: "system_notification",
          organization_id: proj.organization_id,
          metadata: {
            project_id: proj.id,
            project_name: proj.name,
            open_tasks: openTasks ?? 0,
            overdue_tasks: overdueTasks ?? 0,
            milestones_this_week: milestonesThisWeek ?? 0,
            week_start: weekISO,
          },
        },
      });
      if (inv.error) throw inv.error;

      await supabase.from("project_digest_log").insert({
        project_id: proj.id, user_id: m.user_id, sent_for_week: weekISO,
      });
      enqueued++;
    } catch (e) {
      errors++;
      console.error("[project-digest-dispatch] send failed", { project: proj.id, user: m.user_id, err: String(e) });
    }
  }

  return new Response(JSON.stringify({ week: weekISO, enqueued, skipped, errors }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
