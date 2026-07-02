/**
 * Talent notifications helper.
 *
 * Inserts notification rows for talent events so the bell & /me surfaces
 * pick them up automatically. Resolves the recipient user_id from
 * `employees.user_id` when an employee_id is passed.
 *
 * Categories:
 *   - 'talent'  — generic (goal assigned, check-in due, dev plan updated)
 *   - reuses existing notification infrastructure (preferences, digest, bell)
 */
import { supabase } from "@/integrations/supabase/client";

export type TalentNotifKind =
  | "goal.assigned"
  | "goal.updated"
  | "goal.feedback"
  | "goal.checkin_due"
  | "goal.completed"
  | "review.invited"
  | "review.submitted"
  | "review.acknowledged"
  | "competency.assess_due"
  | "development.plan_updated"
  | "training.assigned"
  | "oneonone.scheduled"
  | "oneonone.reminder"
  | "oneonone.action_item"
  | "feedback.received"
  | "kudos.received";

interface NotifyArgs {
  organizationId: string;
  businessId?: string | null;
  employeeId?: string | null;     // resolved to user_id
  userId?: string | null;         // explicit user_id (skip resolution)
  kind: TalentNotifKind;
  title: string;
  message: string;
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  priority?: number;
}

export async function notifyTalent(args: NotifyArgs): Promise<void> {
  let userId = args.userId ?? null;
  if (!userId && args.employeeId) {
    const { data } = await supabase
      .from("v_employees_canonical")
      .select("user_id")
      .eq("id", args.employeeId)
      .maybeSingle();
    userId = (data?.user_id as string | null) ?? null;
  }
  if (!userId) return; // employee not linked to a user account yet — skip silently

  await (supabase.from("notifications") as any).insert({
    organization_id: args.organizationId,
    business_id: args.businessId ?? null,
    user_id: userId,
    type: "info",
    category: "talent",
    title: args.title,
    message: args.message,
    link: args.link ?? null,
    entity_type: args.entityType ?? null,
    entity_id: args.entityId ?? null,
    priority: args.priority ?? 3,
  });
}
