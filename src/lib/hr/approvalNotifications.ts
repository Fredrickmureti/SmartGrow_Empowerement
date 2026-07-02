import { supabase } from "@/integrations/supabase/client";

export type HrApprovalEntity =
  | "leave_request"
  | "timesheet_submission"
  | "overtime_request"
  | "shift_swap_request"
  | "attendance_correction"
  | "expense"
  | "employee_loan";

export type HrApprovalEvent =
  | "submitted"
  | "requested"
  | "pending_second_approval"
  | "approved"
  | "rejected"
  | "cancelled"
  | "disbursed";

interface Notice {
  user_id: string;
  category: string;
  title: string;
  message: string;
  link: string | null;
  entity_type: string;
  entity_id: string;
  business_id: string | null;
  /**
   * Per-recipient channel resolution returned by the H1 RPC. Optional so the
   * client remains forward/backward compatible with the older RPC payload
   * (missing → assume email allowed).
   */
  channels?: { in_app: boolean; email: boolean };
}

interface Args {
  organizationId: string;
  entityType: HrApprovalEntity;
  entityId: string;
  event: HrApprovalEvent;
  actorUserId?: string | null;
}

/**
 * Shared, fire-and-forget HR approval notification dispatcher.
 *
 * Two-step fan-out (no new edge function needed):
 *   1. `hr_notify_approval_event` SECURITY DEFINER RPC resolves recipients,
 *      inserts in-app notifications honouring per-user `in_app_enabled`
 *      preferences, and records a `notification_delivery_log` row per
 *      in-app attempt (sent or pref-suppressed). It also returns a
 *      `channels` object per recipient indicating whether email is
 *      allowed.
 *   2. For each returned notice with `channels.email !== false` we invoke
 *      `send-notification-email`, which independently re-checks
 *      `email_enabled` and routes via the canonical send-email transport
 *      (ADR-0023 tenant sender identity). The email outcome is best-effort
 *      logged into `notification_delivery_log` so the audit trail covers
 *      both channels.
 *
 * Never throws into the caller — a failed notification must NEVER roll back
 * the underlying HR transaction. All call sites should `void` the result.
 */
export async function dispatchApprovalNotification({
  organizationId,
  entityType,
  entityId,
  event,
  actorUserId,
}: Args): Promise<void> {
  try {
    const { data, error } = await (supabase as any).rpc("hr_notify_approval_event", {
      _entity_type: entityType,
      _entity_id: entityId,
      _event: event,
      _actor: actorUserId ?? null,
    });
    if (error) {
      console.error(`[approvalNotifications] RPC ${entityType}.${event} failed:`, error.message);
      return;
    }

    const notices = (data ?? []) as Notice[];
    if (notices.length === 0) return;

    await Promise.allSettled(
      notices.map(async (n) => {
        // Respect per-recipient email channel resolution from the RPC.
        if (n.channels && n.channels.email === false) {
          await logDelivery(organizationId, n, event, "email", "suppressed", "pref_disabled");
          return;
        }
        const { error: emailErr } = await (supabase as any).functions.invoke(
          "send-notification-email",
          {
            body: {
              user_id: n.user_id,
              organization_id: organizationId,
              business_id: n.business_id,
              category: n.category,
              title: n.title,
              message: n.message,
              link: n.link,
              entity_type: n.entity_type,
              entity_id: n.entity_id,
            },
          },
        );
        await logDelivery(
          organizationId,
          n,
          event,
          "email",
          emailErr ? "failed" : "sent",
          emailErr ? emailErr.message ?? "invoke_failed" : null,
        );
      }),
    );
  } catch (err: any) {
    console.error(`[approvalNotifications] dispatch ${entityType}.${event} failed:`, err?.message);
  }
}

async function logDelivery(
  organizationId: string,
  n: Notice,
  event: string,
  channel: "in_app" | "email" | "sms",
  status: "sent" | "suppressed" | "failed",
  suppressedReason: string | null,
): Promise<void> {
  try {
    await (supabase as any).from("notification_delivery_log").insert({
      organization_id: organizationId,
      business_id: n.business_id,
      user_id: n.user_id,
      category: n.category,
      entity_type: n.entity_type,
      entity_id: n.entity_id,
      event,
      channel,
      status,
      suppressed_reason: suppressedReason,
    });
  } catch {
    // best-effort audit — never let a logging failure surface
  }
}
