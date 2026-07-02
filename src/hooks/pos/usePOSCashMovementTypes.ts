import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/contexts/BusinessContext";

export interface CashMovementTypeConfig {
  id: string;
  business_id: string;
  movement_type:
    | "opening_float"
    | "cash_in"
    | "cash_out"
    | "pickup"
    | "safe_drop"
    | "bank_deposit"
    | "petty_cash_out"
    | "correction";
  label: string;
  description: string | null;
  requires_reason: boolean;
  requires_manager_default: boolean;
  gl_debit_account_id: string | null;
  gl_credit_account_id: string | null;
  is_active: boolean;
  sort_order: number;
  /** Tap-to-fill reason chips. Empty = free-text only. */
  reason_presets: string[];
  /** When true, the dialog renders a denomination counter and computes the amount. */
  quick_count_enabled: boolean;
  /** L2: amount above which the cashier must type a reason. NULL = always required. */
  reason_required_above: number | null;
  /** L2: amount above which a manager override is required. */
  manager_required_above: number | null;
  /** L2: preset substituted when amount < reason_required_above. */
  default_reason_preset_id: string | null;
  /** L2: one-tap chips shown next to the amount input. */
  quick_amounts: number[];
}

/**
 * Loads the per-business configuration for POS cash drawer movement types.
 * Drives the type picker in CashDrawerDialog and gates reason / manager
 * approval requirements server-side via process_pos_cash_movement.
 */
export function usePOSCashMovementTypes() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  return useQuery({
    queryKey: ["pos-cash-movement-types", businessId],
    queryFn: async () => {
      if (!businessId) return [] as CashMovementTypeConfig[];
      const { data, error } = await supabase
        .from("pos_cash_movement_types" as any)
        .select("*")
        .eq("business_id", businessId)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as CashMovementTypeConfig[];
    },
    enabled: !!businessId,
    staleTime: 60_000,
  });
}
