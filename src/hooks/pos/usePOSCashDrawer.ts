import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinesses } from "@/contexts/BusinessContext";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { printClient } from "@/services/printing/PrintClient";


export type CashMovementType =
  | "opening_float"
  | "cash_in"
  | "cash_out"
  | "float" // legacy, treated as opening_float by the view
  | "pickup"
  | "drop" // legacy
  | "safe_drop"
  | "bank_deposit"
  | "petty_cash_out"
  | "correction";

export interface CashMovement {
  id: string;
  shift_id: string;
  register_id: string;
  movement_type: CashMovementType;
  amount: number;
  reason_code: string | null;
  reason: string | null;
  notes: string | null;
  performed_by: string | null;
  performed_at: string;
  manager_override_id?: string | null;
  journal_entry_id?: string | null;
}

export function usePOSCashDrawer(shiftId?: string) {
  const { user } = useAuth();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const businessId = currentBusiness?.id;

  const { data: movements = [], isLoading } = useQuery({
    queryKey: ["pos-cash-movements", shiftId, businessId],
    queryFn: async () => {
      if (!shiftId || !businessId) return [];

      // Defense-in-depth: join parent shift and assert it belongs to the active company
      const { data, error } = await supabase
        .from("pos_cash_movements")
        .select("*, pos_shifts!inner(business_id)")
        .eq("shift_id", shiftId)
        .eq("pos_shifts.business_id", businessId)
        .order("performed_at", { ascending: false });

      if (error) throw error;
      return (data ?? []) as unknown as CashMovement[];
    },
    enabled: !!shiftId && !!businessId,
  });

  const addMovement = useMutation({
    mutationFn: async (data: {
      shift_id: string;
      register_id: string;
      organization_id: string;
      business_id: string;
      movement_type: CashMovementType;
      amount: number;
      reason_code?: string;
      reason?: string;
      notes?: string;
      override_id?: string;
    }) => {
      if (!user?.id) throw new Error("Not authenticated");

      // Stage 6: route through process_pos_cash_movement (single atomic
      // entry point that validates shift/register/role, gates manager
      // approval thresholds, updates expected_cash, and posts the
      // journal entry when GL accounts are configured for the type).
      const { data: result, error } = await supabase.rpc(
        "process_pos_cash_movement" as any,
        {
          p_organization_id: data.organization_id,
          p_business_id: data.business_id,
          p_shift_id: data.shift_id,
          p_register_id: data.register_id,
          p_movement_type: data.movement_type,
          p_amount: data.amount,
          p_reason_code: data.reason_code ?? null,
          p_reason: data.reason || null,
          p_notes: data.notes || null,
          p_performed_by: user.id,
          p_override_id: data.override_id ?? null,
        }
      );

      if (error) throw error;
      return result as any;
    },
    onSuccess: (result: any, variables) => {
      queryClient.invalidateQueries({ queryKey: ["pos-cash-movements"] });
      queryClient.invalidateQueries({ queryKey: ["pos-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["pos-current-shift"] });
      queryClient.invalidateQueries({ queryKey: ["pos-cash-expected"] });
      toast.success(`Cash movement recorded (${variables.movement_type.replace(/_/g, " ")})`);

      // Phase B1 — cash-drawer audit slip (SOX / PCI compliance).
      // Every out-of-band drawer open must print a paper slip carrying
      // cashier, timestamp, movement type, amount, reason, and (when
      // present) manager override id. Fire-and-forget: a printer being
      // offline must never abort the cash movement. When no receipt
      // printer is bound the resolver returns `ask_user`/`none` and we
      // silently drop — auditors reconcile from `pos_cash_movements`.
      const movementId = result?.movement_id as string | undefined;
      if (movementId && businessId) {
        void printClient.print({
          intent: "receipt",
          documentType: "drawer_slip",
          documentId: movementId,
          title: `Drawer slip ${variables.movement_type}`,
          organizationId: variables.organization_id,
          businessId,
          branchId: null,
        }).catch((err) => {
          console.warn("[drawer_slip] print dispatch failed (non-blocking)", err);
        });
      }
    },
    onError: (error: Error) => {
      toast.error(`Failed: ${normalizeError(error).message}`);
    },

  });

  const cashInTypes: CashMovementType[] = ["cash_in", "float", "opening_float", "correction"];
  const cashOutTypes: CashMovementType[] = [
    "cash_out", "pickup", "drop", "safe_drop", "bank_deposit", "petty_cash_out",
  ];

  const totalCashIn = movements
    .filter((m) => cashInTypes.includes(m.movement_type))
    .reduce((sum, m) => sum + m.amount, 0);

  const totalCashOut = movements
    .filter((m) => cashOutTypes.includes(m.movement_type))
    .reduce((sum, m) => sum + m.amount, 0);

  return {
    movements,
    isLoading,
    addMovement,
    totalCashIn,
    totalCashOut,
    netCash: totalCashIn - totalCashOut,
  };
}
