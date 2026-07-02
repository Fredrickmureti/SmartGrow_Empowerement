// @ts-nocheck
/**
 * notify-tasks-due-soon
 *
 * Hourly cron. Walks every organization, calls public.tasks_due_soon, and
 * emits one notification per (user, task, day) for two categories:
 *  - task_due_soon  (deadline within 2 days, not yet overdue)
 *  - task_overdue   (deadline before today)
 *
 * Dedupe: relies on idx_notifications_task_due_dedupe + a per-day SELECT to
 * skip rows we already notified today. Re-running in the same hour is a no-op.
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface DueRow {
  task_id: string;
  project_id: string;
  task_name: string;
  deadline: string;
  assigned_to: string | null;
  assignees: string[] | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const today = new Date().toISOString().slice(0, 10);

  const { data: orgs, error: orgErr } = await supabase
    .from("organizations")
    .select("id");
  if (orgErr) {
    return new Response(JSON.stringify({ error: orgErr.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let dueEmitted = 0;
  let overdueEmitted = 0;
  let skipped = 0;

  for (const org of orgs ?? []) {
    const { data: rows, error } = await supabase.rpc("tasks_due_soon", {
      _org: org.id,
      _within_days: 2,
    });
    if (error) {
      console.error("tasks_due_soon failed", org.id, error.message);
      continue;
    }

    for (const r of (rows ?? []) as DueRow[]) {
      const recipients = new Set<string>();
      if (r.assigned_to) recipients.add(r.assigned_to);
      for (const a of r.assignees ?? []) if (a) recipients.add(a);
      if (recipients.size === 0) continue;

      const isOverdue = r.deadline < today;
      const type = isOverdue ? "task_overdue" : "task_due_soon";

      // Project name for human-friendly message
      const { data: proj } = await supabase
        .from("projects")
        .select("name, business_id")
        .eq("id", r.project_id)
        .maybeSingle();

      for (const userId of recipients) {
        // Per-day dedupe
        const { data: existing } = await supabase
          .from("notifications")
          .select("id")
          .eq("user_id", userId)
          .eq("entity_id", r.task_id)
          .eq("type", type)
          .gte("created_at", today + "T00:00:00Z")
          .limit(1)
          .maybeSingle();
        if (existing) {
          skipped++;
          continue;
        }

        const title = isOverdue ? "Task overdue" : "Task due soon";
        const message =
          (proj?.name ? proj.name + " · " : "") +
          r.task_name +
          " (deadline " + r.deadline + ")";

        const { error: nErr } = await supabase.rpc("create_notification", {
          p_organization_id: org.id,
          p_user_id: userId,
          p_type: type,
          p_category: "tasks",
          p_title: title,
          p_message: message,
          p_link:
            "/projects-app/" + r.project_id + "/tasks?task=" + r.task_id,
          p_entity_type: "project_task",
          p_entity_id: r.task_id,
          p_priority: isOverdue ? 2 : 1,
          p_business_id: proj?.business_id ?? null,
        });
        if (nErr) {
          console.error("create_notification failed", nErr.message);
          continue;
        }
        if (isOverdue) overdueEmitted++;
        else dueEmitted++;
      }
    }
  }

  return new Response(
    JSON.stringify({ dueEmitted, overdueEmitted, skipped, ranAt: new Date().toISOString() }),
    { headers: { ...cors, "Content-Type": "application/json" } },
  );
});
