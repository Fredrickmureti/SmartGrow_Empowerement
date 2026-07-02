import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { isValidE164, normalizeE164 } from "@/lib/sms/phone";

export type SmsUnavailableReason =
  | "loading"
  | "not_configured"
  | "disabled"
  | "no_permission"
  | "no_recipient_phone"
  | "invalid_recipient_phone"
  | "recipient_opted_out";

export interface SmsAvailability {
  /** True only if SMS can be sent right now in this context. */
  canSend: boolean;
  /** True if SMS is configured AND enabled for the org (regardless of recipient). */
  configured: boolean;
  /** "test" | "live" — only meaningful when configured. */
  mode: "test" | "live" | null;
  /** Whether the current user has permission to send SMS in this org. */
  userCanSend: boolean;
  /** Resolved recipient phone in E.164 form, or null. */
  recipientPhone: string | null;
  /** Whether the recipient phone is on this org's opt-out list. */
  recipientOptedOut: boolean;
  /** Why SMS is not sendable right now (null if canSend=true). */
  reason: SmsUnavailableReason | null;
  /** Human-friendly explanation of `reason`. */
  reasonMessage: string | null;
  isLoading: boolean;
}

const REASON_MESSAGES: Record<SmsUnavailableReason, string> = {
  loading: "Checking SMS availability…",
  not_configured: "SMS is not configured. An admin can enable it in Settings → SMS.",
  disabled: "SMS is configured but disabled for this organization.",
  no_permission: "You don't have permission to send SMS for this organization.",
  no_recipient_phone: "This recipient has no phone number on file.",
  invalid_recipient_phone: "The recipient's phone number isn't a valid international (E.164) number.",
  recipient_opted_out: "This recipient has opted out of SMS from this organization.",
};

interface UseSmsAvailabilityArgs {
  /** Phone number for the intended recipient (any format — will be normalized). */
  recipientPhone?: string | null;
  /** Skip recipient checks (use for "is SMS configured at all?" surfaces). */
  skipRecipientCheck?: boolean;
}

/**
 * State-aware hook describing whether the current user can send an SMS
 * in the current context (org, recipient, permissions, opt-out).
 *
 * Unlike `useSmsEnabled`, this never silently returns false — it always
 * returns a `reason` and `reasonMessage` explaining why SMS is unavailable.
 *
 * Use this in any UI surface that conditionally shows "Send SMS" so the
 * user understands what's missing instead of seeing the action vanish.
 */
export function useSmsAvailability(args: UseSmsAvailabilityArgs = {}): SmsAvailability {
  const { recipientPhone, skipRecipientCheck } = args;
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;

  const normalizedPhone = recipientPhone ? (normalizeE164(recipientPhone) ?? recipientPhone) : null;

  // Provider config (configured + mode)
  const configQuery = useQuery({
    queryKey: ["sms-availability-config", orgId],
    queryFn: async () => {
      if (!orgId) return null;
      const { data } = await supabase
        .from("sms_provider_configs")
        .select("is_enabled, provider_mode")
        .eq("organization_id", orgId)
        .limit(1)
        .maybeSingle();
      return data as { is_enabled: boolean; provider_mode: "test" | "live" } | null;
    },
    enabled: !!orgId,
    staleTime: 60_000,
  });

  // Permission check — owner/admin/manager can always send; rely on user_roles
  const permissionQuery = useQuery({
    queryKey: ["sms-availability-permission", orgId],
    queryFn: async () => {
      if (!orgId) return false;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return false;
      // Anyone with an active role in the org may send manual SMS today.
      // Backend (`send-sms`) is the source of truth and re-checks.
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("organization_id", orgId)
        .eq("user_id", user.id)
        .eq("is_active", true)
        .limit(1);
      return !!(data && data.length > 0);
    },
    enabled: !!orgId,
    staleTime: 60_000,
  });

  // Opt-out check
  const optOutQuery = useQuery({
    queryKey: ["sms-availability-optout", orgId, normalizedPhone],
    queryFn: async () => {
      if (!orgId || !normalizedPhone || !isValidE164(normalizedPhone)) return false;
      const { data } = await supabase
        .from("sms_opt_outs")
        .select("id")
        .eq("organization_id", orgId)
        .eq("phone_number", normalizedPhone)
        .limit(1)
        .maybeSingle();
      return !!data;
    },
    enabled: !!orgId && !!normalizedPhone && !skipRecipientCheck,
    staleTime: 60_000,
  });

  const isLoading = configQuery.isLoading || permissionQuery.isLoading || optOutQuery.isLoading;
  const cfg = configQuery.data;
  const configured = !!cfg && cfg.is_enabled;
  const mode = cfg?.provider_mode ?? null;
  const userCanSend = !!permissionQuery.data;
  const recipientOptedOut = !!optOutQuery.data;

  let reason: SmsUnavailableReason | null = null;
  if (isLoading) reason = "loading";
  else if (!cfg) reason = "not_configured";
  else if (!cfg.is_enabled) reason = "disabled";
  else if (!userCanSend) reason = "no_permission";
  else if (!skipRecipientCheck) {
    if (!normalizedPhone) reason = "no_recipient_phone";
    else if (!isValidE164(normalizedPhone)) reason = "invalid_recipient_phone";
    else if (recipientOptedOut) reason = "recipient_opted_out";
  }

  return {
    canSend: reason === null,
    configured,
    mode,
    userCanSend,
    recipientPhone: normalizedPhone,
    recipientOptedOut,
    reason,
    reasonMessage: reason ? REASON_MESSAGES[reason] : null,
    isLoading,
  };
}
