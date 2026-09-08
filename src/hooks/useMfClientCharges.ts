/**
 * Client-level charges (admission fee).
 *
 * Money never moves in React: raising, paying and reversing a charge are
 * server routines (`mf_raise_client_admission_fee`, `mf_pay_client_charge`,
 * `mf_reverse_client_charge`) that read the institution's fee policy and post
 * through the lending accounting mappings. This hook only reads rows and
 * forwards intent.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";

export type MfClientChargeStatus = "outstanding" | "paid" | "reversed";

export interface MfClientCharge {
  id: string;
  business_id: string;
  branch_id: string;
  client_id: string;
  kind: string;
  charged_on: string;
  amount: number;
  currency_code: string;
  status: MfClientChargeStatus;
  receipt_number: string | null;
  method: string | null;
  reference: string | null;
  paid_on: string | null;
  notes: string | null;
  journal_entry_id: string | null;
  reversal_journal_entry_id: string | null;
  reversal_reason: string | null;
  reversed_at: string | null;
  created_at: string;
}

export interface MfClientFeePolicy {
  id: string;
  business_id: string;
  admission_fee_active: boolean;
  admission_fee_amount: number | null;
  admission_fee_currency: string | null;
}

const CHARGE_COLUMNS =
  "id,business_id,branch_id,client_id,kind,charged_on,amount,currency_code,status,receipt_number,method,reference,paid_on,notes,journal_entry_id,reversal_journal_entry_id,reversal_reason,reversed_at,created_at";

/** Institution-level admission fee policy (read + save). */
export function useMfClientFeePolicy() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-client-fee-policy", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mf_client_fee_policy")
        .select("id, business_id, admission_fee_active, admission_fee_amount, admission_fee_currency")
        .eq("business_id", businessId!)
        .maybeSingle();
      if (error) throw error;
      return (data as MfClientFeePolicy | null) ?? null;
    },
  });

  const save = useMutation({
    mutationFn: async (input: {
      admission_fee_active: boolean;
      admission_fee_amount: number | null;
      admission_fee_currency: string | null;
    }) => {
      if (!businessId) throw new Error("No institution selected.");
      const payload = { business_id: businessId, ...input };
      const { error } = query.data?.id
        ? await supabase.from("mf_client_fee_policy").update(payload).eq("id", query.data.id)
        : await supabase.from("mf_client_fee_policy").insert(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mf-client-fee-policy", businessId] });
      toast.success("Admission fee policy saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { policy: query.data ?? null, isLoading: query.isLoading, save };
}

/** Charges for one client, newest first, plus the server actions on them. */
export function useMfClientCharges(clientId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-client-charges", clientId],
    enabled: !!clientId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mf_client_charges")
        .select(CHARGE_COLUMNS)
        .eq("client_id", clientId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as MfClientCharge[];
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-client-charges", clientId] });
    queryClient.invalidateQueries({ queryKey: ["mf-client-charges-summary"] });
  };

  const raiseAdmissionFee = useMutation({
    mutationFn: async (input: { chargedOn?: string | null; notes?: string | null }) => {
      const { data, error } = await supabase.rpc("mf_raise_client_admission_fee", {
        p_client_id: clientId!,
        p_charged_on: input.chargedOn ?? undefined,
        p_notes: input.notes ?? undefined,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Admission fee raised");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const payCharge = useMutation({
    mutationFn: async (input: {
      chargeId: string;
      paidOn: string;
      method: string;
      reference: string | null;
      notes: string | null;
    }) => {
      const { data, error } = await supabase.rpc("mf_pay_client_charge", {
        p_charge_id: input.chargeId,
        p_paid_on: input.paidOn,
        p_method: input.method,
        p_reference: input.reference ?? undefined,
        p_notes: input.notes ?? undefined,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Admission fee payment recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverseCharge = useMutation({
    mutationFn: async (input: { chargeId: string; reason: string; effectiveOn?: string | null }) => {
      const { data, error } = await supabase.rpc("mf_reverse_client_charge", {
        p_charge_id: input.chargeId,
        p_reason: input.reason,
        p_effective_on: input.effectiveOn ?? undefined,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Admission fee payment reversed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return {
    charges: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    raiseAdmissionFee,
    payCharge,
    reverseCharge,
  };
}

/** Latest admission-fee status per client for list badges. */
export function useMfClientChargeSummary(clientIds: string[]) {
  const key = [...clientIds].sort().join(",");
  return useQuery({
    queryKey: ["mf-client-charges-summary", key],
    enabled: clientIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mf_client_charges")
        .select("client_id, status, created_at")
        .in("client_id", clientIds)
        .eq("kind", "admission_fee")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const map = new Map<string, MfClientChargeStatus>();
      for (const row of (data ?? []) as Array<{ client_id: string; status: MfClientChargeStatus }>) {
        if (!map.has(row.client_id)) map.set(row.client_id, row.status);
      }
      return map;
    },
  });
}
