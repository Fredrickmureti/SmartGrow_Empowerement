import { supabase } from "@/integrations/supabase/client";

export type LoanLifecycleEvent =
  | "loan.requested"
  | "loan.approved"
  | "loan.authorized"
  | "loan.rejected"
  | "loan.disbursed"
  | "loan.paused"
  | "loan.resumed"
  | "loan.suspended"
  | "loan.cancelled"
  | "loan.settled"
  | "loan.written_off"
  | "loan.restructured";

interface LoanNotice {
  user_id: string;
  category: string;
  title: string;
  message: string;
  link: string;
  entity_type: string;
  entity_id: string;
  business_id: string | null;
}

interface DispatchArgs {
  organizationId: string;
  loanId: string;
  event: LoanLifecycleEvent;
  actorUserId?: string | null;
}

/**
 * Fire-and-forget HR loan-lifecycle notification dispatcher (client side).
 *
 * Two-step fan-out that needs NO dedicated edge function:
 *   1. `hr_notify_loan_event` (SECURITY DEFINER RPC) resolves recipients
 *      (payroll approvers + manager on request; employee on
 *      approve/reject/disburse), inserts the in-app notifications honouring
 *      each user's `in_app_enabled` preference, and returns the notices.
 *   2. For each returned notice we invoke the existing `send-notification-email`
 *      edge function, which re-checks `email_enabled` and sends a branded
 *      email via the canonical `send-email` transport (ADR-0023 identity).
 *
 * Never throws into the caller — a failed notification must never roll back
 * the underlying loan transaction.
 */
export async function dispatchLoanNotification({
  organizationId,
  loanId,
  event,
  actorUserId,
}: DispatchArgs): Promise<void> {
  try {
    const { data, error } = await (supabase as any).rpc("hr_notify_loan_event", {
      _loan_id: loanId,
      _event: event,
      _actor: actorUserId ?? null,
    });
    if (error) {
      console.error(`[loanNotifications] RPC ${event} failed:`, error.message);
      return;
    }

    const notices = (data ?? []) as LoanNotice[];
    await Promise.allSettled(
      notices.map((n) =>
        (supabase as any).functions.invoke("send-notification-email", {
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
        }),
      ),
    );
  } catch (err: any) {
    console.error(`[loanNotifications] dispatch ${event} failed:`, err?.message);
  }
}
