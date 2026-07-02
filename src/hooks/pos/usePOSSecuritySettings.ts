import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useBranch } from "@/contexts/BranchContext";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

/**
 * Stage 8.6 — PIN/threshold gate flags retired.
 *
 * The following columns were dropped from `pos_security_settings`:
 *   require_manager_pin_for_void, void_requires_manager_above_amount,
 *   require_manager_pin_for_return, return_requires_manager_above_amount,
 *   require_manager_pin_for_discount, discount_limit_requires_approval,
 *   cash_out_requires_manager_above_amount, safe_drop_requires_manager_above_amount,
 *   bank_deposit_requires_manager_above_amount, shift_variance_requires_manager_above_amount.
 *
 * All PIN + threshold decisions are now read server-side from `pos_override_matrix`
 * inside `assert_manager_override`. Callers MUST submit the action optimistically
 * and react to the `override_required` Postgres exception (SQLSTATE 42501) by
 * prompting for a manager PIN and replaying the call with the resulting
 * `override_id`. There is no longer a client-readable "should I prompt?" flag —
 * doing so would silently ignore matrix changes made by an admin.
 */
export interface POSSecuritySettings {
  require_cashier_pin: boolean;
  pin_length: number;
  session_timeout_minutes: number;
  lock_after_inactivity_minutes: number;
  require_manager_pin_for_price_override: boolean;
  require_manager_pin_for_drawer_open: boolean;
  void_limit_requires_approval: number;
  allow_offline_transactions: boolean;
  max_offline_transaction_amount: number;
}

const DEFAULT_SETTINGS: POSSecuritySettings = {
  require_cashier_pin: true,
  pin_length: 4,
  session_timeout_minutes: 30,
  lock_after_inactivity_minutes: 5,
  require_manager_pin_for_price_override: true,
  require_manager_pin_for_drawer_open: false,
  void_limit_requires_approval: 0,
  allow_offline_transactions: true,
  max_offline_transaction_amount: 10000,
};

export function usePOSSecuritySettings() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { currentBranch } = useBranch();
  const queryClient = useQueryClient();

  const { data: settings = DEFAULT_SETTINGS, isLoading } = useQuery({
    queryKey: ["pos-security-settings", currentOrg?.id, currentBusiness?.id, currentBranch?.id ?? null],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return DEFAULT_SETTINGS;

      // Use the branch-aware resolver: returns the per-branch override row
      // when one exists for the active branch, otherwise the company-default
      // (branch_id IS NULL) row. This is what makes per-branch PIN/threshold
      // ceilings actually take effect without changing call-sites.
      const { data: rpcRows, error } = await supabase.rpc(
        "resolve_pos_security_settings" as any,
        {
          p_business_id: currentBusiness.id,
          p_branch_id: currentBranch?.id ?? null,
        } as any,
      );
      const data = Array.isArray(rpcRows) ? (rpcRows[0] as any) : null;

      if (error) throw error;

      if (!data) {
        // No row yet for this scope — return defaults. Seeding happens on
        // first save through `upsert_pos_security_settings` (single
        // transactional path; no lazy INSERT race with the mutation).
        return { ...DEFAULT_SETTINGS };
      }

      const d = data as any;
      return {
        require_cashier_pin: d.require_cashier_pin ?? DEFAULT_SETTINGS.require_cashier_pin,
        pin_length: d.pin_length ?? DEFAULT_SETTINGS.pin_length,
        session_timeout_minutes: d.session_timeout_minutes ?? DEFAULT_SETTINGS.session_timeout_minutes,
        lock_after_inactivity_minutes: d.lock_after_inactivity_minutes ?? DEFAULT_SETTINGS.lock_after_inactivity_minutes,
        require_manager_pin_for_price_override: d.require_manager_pin_for_price_override ?? DEFAULT_SETTINGS.require_manager_pin_for_price_override,
        require_manager_pin_for_drawer_open: d.require_manager_pin_for_drawer_open ?? DEFAULT_SETTINGS.require_manager_pin_for_drawer_open,
        void_limit_requires_approval: d.void_limit_requires_approval ?? DEFAULT_SETTINGS.void_limit_requires_approval,
        allow_offline_transactions: d.allow_offline_transactions ?? DEFAULT_SETTINGS.allow_offline_transactions,
        max_offline_transaction_amount: d.max_offline_transaction_amount ?? DEFAULT_SETTINGS.max_offline_transaction_amount,
      } as POSSecuritySettings;
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  const { data: hasManagerPin = false } = useQuery({
    queryKey: ["pos-manager-pin-exists", currentOrg?.id, currentBusiness?.id, user?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id || !user?.id) return false;
      const { data, error } = await supabase
        .from("pos_manager_pins")
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      return !!data;
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id && !!user?.id,
  });

  const updateSettings = useMutation({
    mutationFn: async (updates: Partial<POSSecuritySettings>) => {
      if (!currentOrg?.id) throw new Error("No organization");
      if (!currentBusiness?.id) throw new Error("No company selected");

      // Single transactional save path. The RPC handles INSERT vs UPDATE
      // against the correct (org, business, branch) conflict target, so
      // the legacy "duplicate key on organization_id" 409 cannot recur.
      // `p_branch_id = null` writes the company-default row; a future
      // per-branch override editor passes `currentBranch?.id`.
      const { error } = await supabase.rpc("upsert_pos_security_settings" as any, {
        p_business_id: currentBusiness.id,
        p_branch_id: null,
        p_updates: updates as any,
      } as any);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Security settings updated");
      queryClient.invalidateQueries({ queryKey: ["pos-security-settings"] });
    },
    onError: (error: any) => {
      toast.error(normalizeError(error).message || "Failed to update settings");
    },
  });

  const setManagerPin = useMutation({
    mutationFn: async (pin: string) => {
      if (!currentOrg?.id || !user?.id) throw new Error("Not authenticated");
      if (!currentBusiness?.id) throw new Error("No company selected");

      const { data, error } = await supabase.rpc("set_manager_pin" as any, {
        p_organization_id: currentOrg.id,
        p_business_id: currentBusiness.id,
        p_user_id: user.id,
        p_pin: pin,
      } as any);

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Manager PIN updated");
      queryClient.invalidateQueries({ queryKey: ["pos-manager-pin-exists"] });
    },
    onError: (error: any) => {
      toast.error(normalizeError(error).message || "Failed to set PIN");
    },
  });

  return {
    settings,
    isLoading,
    updateSettings,
    setManagerPin,
    hasManagerPin,
  };
}

/**
 * Stage 8.6 helper: detect the `override_required` exception raised by
 * `assert_manager_override` (SQLSTATE 42501, message starts with `override_required`).
 * Use in mutation onError to decide whether to prompt for a manager PIN.
 */
export function isOverrideRequiredError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { message?: string; code?: string; details?: string; hint?: string };
  const msg = (e.message || "") + " " + (e.details || "") + " " + (e.hint || "");
  return /override_required/i.test(msg);
}

/**
 * Parse the structured DETAIL payload `assert_manager_override` attaches to
 * the `override_required` exception so the PIN dialog can show the cashier
 * what action and amount they're approving.
 */
export function parseOverrideRequiredPayload(error: unknown): {
  action?: string;
  threshold?: number;
  amount?: number;
} {
  const e = error as { details?: string; hint?: string };
  for (const candidate of [e?.details, e?.hint]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // hint is plain text — fall through
    }
  }
  return {};
}
