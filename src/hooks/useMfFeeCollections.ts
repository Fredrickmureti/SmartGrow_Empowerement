/**
 * Admission-fee positions and group collections.
 *
 * The obligation always belongs to the individual client. A group collection is
 * only the cash hand-over context: the server routine
 * `mf_collect_group_admission_fees` validates each member's real outstanding
 * amount, writes one settlement row per member and posts a single journal
 * entry. React never computes or allocates money.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";

export interface MfClientFeePosition {
  client_id: string;
  business_id: string;
  branch_id: string;
  client_number: string;
  full_name: string;
  group_id: string | null;
  charge_id: string | null;
  charged_on: string | null;
  currency_code: string | null;
  fee_amount: number;
  paid_amount: number;
  outstanding_amount: number;
  charge_status: string;
  last_collection_id: string | null;
  last_paid_on: string | null;
}

export interface MfFeeCollection {
  id: string;
  business_id: string;
  branch_id: string;
  group_id: string;
  collection_number: string;
  collected_on: string;
  collected_by: string | null;
  total_amount: number;
  currency_code: string | null;
  method: string | null;
  reference: string | null;
  notes: string | null;
  status: string;
  journal_entry_id: string | null;
  reversal_reason: string | null;
  reversed_at: string | null;
  created_at: string;
}

export interface MfFeeCollectionLine {
  client_id: string;
  amount: number;
}

const POSITION_COLUMNS =
  "client_id,business_id,branch_id,client_number,full_name,group_id,charge_id,charged_on,currency_code,fee_amount,paid_amount,outstanding_amount,charge_status,last_collection_id,last_paid_on";

/** Fee position of every active member of one group. */
export function useMfGroupFeePositions(groupId: string | null) {
  return useQuery({
    queryKey: ["mf-group-fee-positions", groupId],
    enabled: !!groupId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mf_client_fee_positions")
        .select(POSITION_COLUMNS)
        .eq("group_id", groupId!)
        .order("client_number");
      if (error) throw error;
      return (data ?? []) as unknown as MfClientFeePosition[];
    },
  });
}

/** Fee position of a single client (used when adding a member to a group). */
export function useMfClientFeePosition(clientId: string | null) {
  return useQuery({
    queryKey: ["mf-client-fee-position", clientId],
    enabled: !!clientId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mf_client_fee_positions")
        .select(POSITION_COLUMNS)
        .eq("client_id", clientId!)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as MfClientFeePosition | null) ?? null;
    },
  });
}

/** Collection history for a group, plus the collect and reverse actions. */
export function useMfFeeCollections(groupId: string | null) {
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-fee-collections", groupId],
    enabled: !!groupId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mf_fee_collections")
        .select("*")
        .eq("group_id", groupId!)
        .order("collected_on", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as MfFeeCollection[];
    },
  });

  const allocations = useQuery({
    queryKey: ["mf-fee-collection-allocations", groupId],
    enabled: !!groupId,
    queryFn: async () => {
      const ids = (query.data ?? []).map((c) => c.id);
      if (ids.length === 0) return [];
      const { data, error } = await supabase
        .from("mf_client_charge_payments")
        .select("id,collection_id,client_id,amount,receipt_number,status,paid_on")
        .in("collection_id", ids);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        collection_id: string | null;
        client_id: string;
        amount: number;
        receipt_number: string | null;
        status: string;
        paid_on: string;
      }>;
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-fee-collections", groupId] });
    queryClient.invalidateQueries({ queryKey: ["mf-fee-collection-allocations", groupId] });
    queryClient.invalidateQueries({ queryKey: ["mf-group-fee-positions", groupId] });
    queryClient.invalidateQueries({ queryKey: ["mf-client-fee-position"] });
    queryClient.invalidateQueries({ queryKey: ["mf-client-charges"] });
    queryClient.invalidateQueries({ queryKey: ["mf-client-charges-summary"] });
  };

  const collect = useMutation({
    mutationFn: async (input: {
      collectedOn: string;
      method: string;
      reference: string | null;
      notes: string | null;
      lines: MfFeeCollectionLine[];
      requestId: string;
    }) => {
      if (!groupId) throw new Error("No group selected.");
      const { data, error } = await supabase.rpc("mf_collect_group_admission_fees", {
        p_group_id: groupId,
        p_collected_on: input.collectedOn,
        p_method: input.method,
        p_reference: input.reference ?? undefined,
        p_notes: input.notes ?? undefined,
        p_lines: input.lines as unknown as never,
        p_client_request_id: input.requestId,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Group fee collection recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverse = useMutation({
    mutationFn: async (input: { collectionId: string; reason: string }) => {
      const { data, error } = await supabase.rpc("mf_reverse_fee_collection", {
        p_collection_id: input.collectionId,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data as string | null;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Collection reversed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return {
    collections: query.data ?? [],
    allocations: allocations.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    currency: currentBusiness?.base_currency ?? null,
    collect,
    reverse,
  };
}

/**
 * Deterministic retry key: the same group, date, method, reference and member
 * amounts always produce the same key, so a double-click or network retry
 * replays instead of taking the money twice.
 */
export function makeFeeCollectionRequestId(
  groupId: string,
  collectedOn: string,
  method: string,
  reference: string | null,
  lines: MfFeeCollectionLine[],
): string {
  const body = [...lines]
    .map((l) => `${l.client_id}:${l.amount.toFixed(2)}`)
    .sort()
    .join("|");
  return `gfc:${groupId}:${collectedOn}:${method}:${reference ?? ""}:${body}`;
}
