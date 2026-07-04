/**
 * Talent notifications helper.
 *
 * Inserts notification rows for talent events so the bell & /me surfaces
 * pick them up automatically. Resolves recipient user_id from
 * `v_employees_canonical.user_id` in a single round-trip when many
 * recipients are passed (bulk path).
 *
 * Categories:
 *   - 'talent'  — generic (goal assigned, check-in due, dev plan updated, merit)
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
  | "review.rating_calibrated"
  | "competency.assess_due"
  | "competency.uplifted"
  | "development.plan_updated"
  | "training.assigned"
  | "oneonone.scheduled"
  | "oneonone.reminder"
  | "oneonone.action_item"
  | "feedback.received"
  | "kudos.received"
  | "merit.applied"
  | "nine_box.placed"
  | "succession.designated"
  | "succession.ready";

interface BaseNotifArgs {
  organizationId: string;
  businessId?: string | null;
  kind: TalentNotifKind;
  title: string;
  message: string;
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  priority?: number;
}

interface NotifyArgs extends BaseNotifArgs {
  employeeId?: string | null;
  userId?: string | null;
}

interface NotifyBulkArgs extends BaseNotifArgs {
  employeeIds?: string[];
  userIds?: string[];
}

function buildRow(args: BaseNotifArgs, userId: string) {
  return {
    organization_id: args.organizationId,
    business_id: args.businessId ?? null,
    user_id: userId,
    type: "info" as const,
    category: "talent" as const,
    title: args.title,
    message: args.message,
    link: args.link ?? null,
    entity_type: args.entityType ?? null,
    entity_id: args.entityId ?? null,
    priority: args.priority ?? 3,
  };
}

/**
 * Bulk notification insert — single canonical-view SELECT + single INSERT.
 * Silently drops employees with no linked user account.
 */
export async function notifyTalentBulk(args: NotifyBulkArgs): Promise<void> {
  const userIds = new Set<string>((args.userIds ?? []).filter(Boolean));

  if (args.employeeIds && args.employeeIds.length > 0) {
    const { data } = await supabase
      .from("v_employees_canonical")
      .select("user_id")
      .in("id", args.employeeIds);
    for (const row of data ?? []) {
      const uid = (row as any).user_id as string | null;
      if (uid) userIds.add(uid);
    }
  }

  if (userIds.size === 0) return;

  const rows = Array.from(userIds).map((uid) => buildRow(args, uid));
  await (supabase.from("notifications") as any).insert(rows);
}

/**
 * Single-recipient helper; delegates to the bulk path so behaviour stays
 * consistent (one code path to reason about).
 */
export async function notifyTalent(args: NotifyArgs): Promise<void> {
  await notifyTalentBulk({
    ...args,
    employeeIds: args.employeeId ? [args.employeeId] : undefined,
    userIds: args.userId ? [args.userId] : undefined,
  });
}
