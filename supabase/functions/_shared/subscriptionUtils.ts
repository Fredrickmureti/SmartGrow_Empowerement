/**
 * Shared Subscription Utilities
 * 
 * Centralized logic for subscription date extension, activation,
 * and payment recording. Used by all payment provider callbacks.
 */

// ─── Subscription Date Extension Logic ───────────────────────────────────────
// Uses max(current_end, now) + period to correctly handle prepayments & renewals
export function calculateExtendedEndDate(
  currentEndsAt: string | null,
  billingCycle: string
): Date {
  const now = new Date();
  const currentEnd = currentEndsAt ? new Date(currentEndsAt) : now;
  const base = currentEnd > now ? currentEnd : now;

  if (billingCycle === "yearly") {
    base.setFullYear(base.getFullYear() + 1);
  } else {
    base.setMonth(base.getMonth() + 1);
  }
  return base;
}

/**
 * Activates or extends a subscription after a successful payment.
 * Handles: org update, payment recording, and audit logging.
 */
export async function activateSubscription(
  supabase: any,
  params: {
    organizationId: string;
    planId: string;
    billingCycle: string;
    paymentMethod: string;
    amount: number;
    currency: string;
    userId?: string | null;
    notes: string;
  }
): Promise<{ endDate: Date; error?: string }> {
  const { organizationId, planId, billingCycle, paymentMethod, amount, currency, userId, notes } = params;

  // Get plan details
  const { data: plan } = await supabase
    .from("platform_subscription_plans")
    .select("*")
    .eq("id", planId)
    .single();

  // Get current org state
  const { data: org } = await supabase
    .from("organizations")
    .select("subscription_ends_at, subscription_started_at, subscription_plan_id")
    .eq("id", organizationId)
    .single();

  // Calculate new end date using max(current_end, now) + period
  const endDate = calculateExtendedEndDate(
    org?.subscription_ends_at,
    billingCycle || "monthly"
  );

  const now = new Date();
  const shouldUpdateStartDate = !org?.subscription_started_at || org?.subscription_plan_id !== planId;

  // Build org update payload
  const orgUpdate: Record<string, any> = {
    subscription_plan_id: planId,
    subscription_status: "active",
    subscription_ends_at: endDate.toISOString(),
    is_suspended: false,
    suspended_at: null,
    suspended_reason: null,
    updated_at: now.toISOString(),
  };

  if (shouldUpdateStartDate) {
    orgUpdate.subscription_started_at = now.toISOString();
  }

  const { error: orgError } = await supabase
    .from("organizations")
    .update(orgUpdate)
    .eq("id", organizationId);

  if (orgError) {
    console.error("Error updating organization:", orgError);
    return { endDate, error: orgError.message };
  }

  // Record payment
  await supabase.from("subscription_payments").insert({
    organization_id: organizationId,
    plan_id: planId,
    amount,
    currency,
    payment_method: paymentMethod,
    period_start: now.toISOString(),
    period_end: endDate.toISOString(),
    status: "completed",
    notes,
  });

  // Audit log
  await supabase.from("audit_logs").insert({
    organization_id: organizationId,
    entity_type: "subscription",
    entity_id: planId,
    action: "payment_completed",
    user_id: userId || null,
    changes_summary: `${paymentMethod.toUpperCase()} payment completed for ${plan?.name || "subscription"} plan (${billingCycle}). Active until ${endDate.toISOString().split("T")[0]}.`,
  });

  console.log(`Subscription activated for org ${organizationId} via ${paymentMethod}, ends ${endDate.toISOString()}`);
  return { endDate };
}

/**
 * Quick check if an org's subscription is active.
 * For use in background jobs/cron functions.
 */
export async function isOrgSubscriptionActive(
  supabase: any,
  orgId: string
): Promise<boolean> {
  const { data: org } = await supabase
    .from("organizations")
    .select("subscription_status, subscription_ends_at, trial_ends_at, is_suspended")
    .eq("id", orgId)
    .single();

  if (!org || org.is_suspended) return false;

  const now = new Date();
  return (
    org.subscription_status === null ||
    (org.subscription_status === "active" && (!org.subscription_ends_at || new Date(org.subscription_ends_at) > now)) ||
    (org.subscription_status === "trial" && (!org.trial_ends_at || new Date(org.trial_ends_at) > now))
  );
}
