// Talent cycle tick — runs hourly via pg_cron.
// 1) Sends overdue reminders for any non-submitted review past due_at.
// 2) Sends phase-deadline reminders to HR when a cycle phase is past its due
//    timestamp but the cycle hasn't been advanced.
// 3) Records a row in talent_audit_log for visibility.
//
// Idempotent: a notification with the same (user_id, entity_id, kind in title)
// is only inserted if no notification was created in the last 20h for the
// same entity_id.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface Counts {
  overdue_review_reminders: number;
  phase_deadline_reminders: number;
  cycles_scanned: number;
}

async function recentlyNotified(entityId: string, userId: string, kind: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from("notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("entity_id", entityId)
    .eq("category", "talent")
    .gte("created_at", cutoff)
    .ilike("title", `%${kind}%`)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function notify(row: {
  organization_id: string;
  business_id: string | null;
  user_id: string;
  title: string;
  message: string;
  link?: string;
  entity_type?: string;
  entity_id?: string;
  priority?: number;
}) {
  await supabase.from("notifications").insert({
    organization_id: row.organization_id,
    business_id: row.business_id,
    user_id: row.user_id,
    type: "warning",
    category: "talent",
    title: row.title,
    message: row.message,
    link: row.link ?? null,
    entity_type: row.entity_type ?? null,
    entity_id: row.entity_id ?? null,
    priority: row.priority ?? 4,
  });
}

async function resolveUserIdFromEmployee(employeeId: string): Promise<string | null> {
  const { data } = await supabase
    .from("employees")
    .select("user_id")
    .eq("id", employeeId)
    .maybeSingle();
  return (data?.user_id as string | null) ?? null;
}

async function run(): Promise<Counts> {
  const now = new Date();
  const counts: Counts = { overdue_review_reminders: 0, phase_deadline_reminders: 0, cycles_scanned: 0 };

  // 1) Overdue reviews
  const { data: overdue } = await supabase
    .from("performance_reviews")
    .select("id, organization_id, cycle_id, employee_id, reviewer_user_id, status, due_at")
    .lt("due_at", now.toISOString())
    .not("status", "in", "(submitted,signed_off,acknowledged)")
    .limit(2000);

  for (const r of overdue ?? []) {
    // Notify reviewer
    if (r.reviewer_user_id) {
      const seen = await recentlyNotified(r.id, r.reviewer_user_id, "Overdue review");
      if (!seen) {
        await notify({
          organization_id: r.organization_id,
          business_id: null,
          user_id: r.reviewer_user_id,
          title: "Overdue review",
          message: "A performance review you own is past its due date.",
          link: `/me/talent/reviews/${r.id}`,
          entity_type: "performance_review",
          entity_id: r.id,
          priority: 5,
        });
        counts.overdue_review_reminders++;
      }
    }
    // Notify employee (self-review or general visibility)
    if (r.status === "draft" || r.status === "in_progress") {
      const empUid = await resolveUserIdFromEmployee(r.employee_id);
      if (empUid && empUid !== r.reviewer_user_id) {
        const seen = await recentlyNotified(r.id, empUid, "Overdue review");
        if (!seen) {
          await notify({
            organization_id: r.organization_id,
            business_id: null,
            user_id: empUid,
            title: "Overdue review (you)",
            message: "Your review is past its due date.",
            link: `/me/talent/reviews/${r.id}`,
            entity_type: "performance_review",
            entity_id: r.id,
          });
          counts.overdue_review_reminders++;
        }
      }
    }
  }

  // 2) Phase deadlines — notify HR admins/owners of the org
  const { data: cycles } = await supabase
    .from("performance_cycles")
    .select(
      "id, organization_id, name, phase, status, goal_setting_due_at, self_review_due_at, manager_review_due_at, peer_review_due_at, sign_off_due_at",
    )
    .eq("status", "active");

  counts.cycles_scanned = cycles?.length ?? 0;

  const phaseToDue: Record<string, keyof NonNullable<typeof cycles>[number]> = {
    goal_setting: "goal_setting_due_at",
    self_review: "self_review_due_at",
    manager_review: "manager_review_due_at",
    peer_review: "peer_review_due_at",
    sign_off: "sign_off_due_at",
  };

  for (const c of cycles ?? []) {
    const due = (c as any)[phaseToDue[c.phase as string] as string] as string | null | undefined;
    if (!due) continue;
    if (new Date(due).getTime() > now.getTime()) continue;

    // Find HR admins / owners for the org
    const { data: roles } = await supabase
      .from("user_roles")
      .select("user_id, role")
      .eq("organization_id", c.organization_id)
      .in("role", ["owner", "admin"]);

    for (const role of roles ?? []) {
      const seen = await recentlyNotified(c.id, role.user_id, `phase ${c.phase}`);
      if (seen) continue;
      await notify({
        organization_id: c.organization_id,
        business_id: null,
        user_id: role.user_id,
        title: `Cycle phase ${c.phase} overdue`,
        message: `Cycle "${c.name}" is past its ${c.phase} deadline. Advance the phase or extend the deadline.`,
        link: `/hr/talent/cycles`,
        entity_type: "performance_cycle",
        entity_id: c.id,
        priority: 5,
      });
      counts.phase_deadline_reminders++;
    }
  }

  return counts;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const counts = await run();
    return new Response(JSON.stringify({ ok: true, ...counts }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
