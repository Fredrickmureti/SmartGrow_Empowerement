// @ts-nocheck
/**
 * generate-recurring-tasks
 *
 * Daily cron. For each project_tasks row flagged is_recurring=true with a
 * recurrence_rule like { freq: "daily"|"weekly"|"monthly", interval: 1, until?: "YYYY-MM-DD" }
 * and a recurrence_next_at <= today, materialize a child task copy stamped
 * with scheduled_for = recurrence_next_at, then advance recurrence_next_at
 * to the next occurrence.
 *
 * Idempotent: a unique index on (recurrence_parent_id, scheduled_for) makes
 * the second run of the same day a no-op (insert is swallowed; cursor still
 * advances).
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface RecurrenceRule {
  freq?: "daily" | "weekly" | "monthly";
  interval?: number;
  until?: string;
}

function nextDate(from: string, rule: RecurrenceRule): string {
  const d = new Date(from + "T00:00:00Z");
  const i = Math.max(1, rule.interval ?? 1);
  switch (rule.freq) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7 * i);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + i);
      break;
    case "daily":
    default:
      d.setUTCDate(d.getUTCDate() + i);
  }
  return d.toISOString().slice(0, 10);
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
  let generated = 0;
  let skipped = 0;
  let advanced = 0;
  const errors: string[] = [];

  // Pull all active recurring "templates" (parents). A template is a task with
  // is_recurring=true and recurrence_parent_id IS NULL.
  const { data: templates, error: tErr } = await supabase
    .from("project_tasks")
    .select(
      "id, organization_id, business_id, project_id, stage_id, milestone_id, name, description, planned_hours, priority, tags, assigned_to, assignees, recurrence_rule, recurrence_next_at",
    )
    .eq("is_recurring", true)
    .is("recurrence_parent_id", null)
    .eq("is_active", true)
    .lte("recurrence_next_at", today);

  if (tErr) {
    return new Response(JSON.stringify({ error: tErr.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  for (const t of templates ?? []) {
    const tpl = t as any;
    const rule = (tpl.recurrence_rule ?? {}) as RecurrenceRule;
    const due = tpl.recurrence_next_at as string | null;
    if (!due) {
      skipped++;
      continue;
    }
    if (rule.until && due > rule.until) {
      skipped++;
      continue;
    }

    const { error: insErr } = await supabase.from("project_tasks").insert({
      organization_id: tpl.organization_id,
      business_id: tpl.business_id,
      project_id: tpl.project_id,
      stage_id: tpl.stage_id,
      milestone_id: tpl.milestone_id,
      name: tpl.name,
      description: tpl.description,
      planned_hours: tpl.planned_hours,
      priority: tpl.priority ?? 0,
      tags: tpl.tags,
      assigned_to: tpl.assigned_to,
      assignees: tpl.assignees,
      recurrence_parent_id: tpl.id,
      scheduled_for: due,
      deadline: due,
      is_recurring: false,
      is_active: true,
    } as any);

    if (insErr) {
      // Unique-index violation = already generated for that day → idempotent no-op
      if (!String(insErr.code) /* PG conflict */ || (insErr as any).code !== "23505") {
        errors.push(`${tpl.id}: ${insErr.message}`);
      }
    } else {
      generated++;
    }

    // Advance cursor regardless (so the second run today still skips).
    const next = nextDate(due, rule);
    const { error: updErr } = await supabase
      .from("project_tasks")
      .update({ recurrence_next_at: next } as any)
      .eq("id", tpl.id);
    if (!updErr) advanced++;
  }

  return new Response(
    JSON.stringify({ ok: true, today, generated, skipped, advanced, errors }),
    { headers: { ...cors, "Content-Type": "application/json" } },
  );
});
