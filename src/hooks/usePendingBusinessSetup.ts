import { useCallback, useMemo } from "react";

export interface PendingBusinessSetup {
  /** Workspace name (Org). May equal companyName when user kept defaults. */
  businessName: string;
  /** Company (legal entity) display name. Defaults to businessName. */
  companyName?: string;
  country: string;
  currency: string;
  businessType: string;
  industry?: string | null;
  legalName?: string | null;
}

/**
 * Hook for managing pending business setup data during onboarding.
 *
 * SOURCE OF TRUTH: `auth.users.user_metadata` (set by SignupForm via supabase.auth.signUp).
 *
 * The previous localStorage backup was removed (Phase E of the architecture
 * audit) — it was race-prone (forced a setTimeout retry in OnboardingSetup)
 * and broke entirely on cross-device email confirmation (open verification
 * link on phone → localStorage gone). User metadata travels with the JWT
 * and is the only durable source.
 */
export function usePendingBusinessSetup(userMetadata?: Record<string, any> | null) {
  const metadataPendingSetup = useMemo((): PendingBusinessSetup | null => {
    if (!userMetadata) return null;

    const meta = userMetadata;
    // Canonical key is `pending_company_name`. Older accounts may still have
    // `pending_business_name` written by a previous version of SignupForm —
    // accept it as a fallback so in-flight signups don't break.
    const pendingName = meta.pending_company_name || meta.pending_business_name;
    if (pendingName && meta.onboarding_completed !== true) {
      return {
        businessName: pendingName,
        companyName: pendingName,
        country: meta.pending_country || "",
        currency: meta.pending_currency || "",
        businessType: meta.pending_business_type || "",
        industry: meta.pending_industry || null,
        legalName: meta.pending_legal_name || null,
      };
    }
    return null;
  }, [userMetadata]);

  const getPendingSetup = useCallback((): PendingBusinessSetup | null => {
    return metadataPendingSetup;
  }, [metadataPendingSetup]);

  const clearPendingSetup = useCallback(() => {
    // No-op: metadata is cleared by OnboardingSetup via supabase.auth.updateUser.
    // Kept as a stable API so callers don't need to change.
  }, []);

  const hasPendingSetup = useCallback((): boolean => {
    return metadataPendingSetup !== null;
  }, [metadataPendingSetup]);

  const storePendingSetup = useCallback((_setup: PendingBusinessSetup) => {
    // No-op: SignupForm writes directly to user_metadata via supabase.auth.signUp.
    // Kept as a stable API for backward compatibility.
  }, []);

  return {
    getPendingSetup,
    clearPendingSetup,
    hasPendingSetup,
    storePendingSetup,
  };
}
