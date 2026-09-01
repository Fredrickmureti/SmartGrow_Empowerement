/**
 * Microfinance client master (C3).
 *
 * The client is the institution's member record: KYC identity, owning branch
 * and loan officer, status and cycle history. Clients survive loan closure —
 * nothing here is derived from a loan.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";

export type MfClientStatus =
  | "prospect"
  | "active"
  | "dormant"
  | "exited"
  | "blacklisted";

export const MF_CLIENT_STATUSES: MfClientStatus[] = [
  "prospect",
  "active",
  "dormant",
  "exited",
  "blacklisted",
];

export interface MfClient {
  id: string;
  business_id: string;
  branch_id: string;
  client_number: string;
  full_name: string;
  national_id: string | null;
  date_of_birth: string | null;
  gender: string | null;
  phone: string | null;
  email: string | null;
  physical_address: string | null;
  occupation: string | null;
  business_type: string | null;
  business_location: string | null;
  next_of_kin_name: string | null;
  next_of_kin_relationship: string | null;
  next_of_kin_phone: string | null;
  loan_officer_id: string | null;
  joined_on: string;
  status: MfClientStatus;
  completed_cycles: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type MfClientInput = Partial<Omit<MfClient, "id" | "business_id" | "created_at" | "updated_at">> & {
  branch_id: string;
  client_number: string;
  full_name: string;
};

const SELECT =
  "id,business_id,branch_id,client_number,full_name,national_id,date_of_birth,gender,phone,email,physical_address,occupation,business_type,business_location,next_of_kin_name,next_of_kin_relationship,next_of_kin_phone,loan_officer_id,joined_on,status,completed_cycles,notes,created_at,updated_at";

export function useMfClients(options?: { branchId?: string | null; status?: MfClientStatus | "all" }) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();
  const branchId = options?.branchId ?? null;
  const status = options?.status ?? "all";

  const query = useQuery({
    queryKey: ["mf-clients", businessId, branchId, status],
    queryFn: async () => {
      if (!businessId) return [] as MfClient[];
      let q = supabase
        .from("mf_clients")
        .select(SELECT)
        .eq("business_id", businessId)
        .order("full_name", { ascending: true });
      if (branchId) q = q.eq("branch_id", branchId);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as MfClient[];
    },
    enabled: !!businessId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-clients"] });
  };

  const createClient = useMutation({
    mutationFn: async (input: MfClientInput) => {
      if (!businessId) throw new Error("No institution selected");
      const { data: auth } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("mf_clients")
        .insert({ ...input, business_id: businessId, created_by: auth.user?.id ?? null })
        .select(SELECT)
        .single();
      if (error) throw error;
      return data as MfClient;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Client registered");
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Could not register the client");
    },
  });

  const updateClient = useMutation({
    mutationFn: async ({ id, ...patch }: Partial<MfClientInput> & { id: string }) => {
      const { error } = await supabase.from("mf_clients").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Client updated");
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Could not update the client");
    },
  });

  return {
    clients: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    createClient,
    updateClient,
    businessId,
  };
}

/** Next sequential client number for the institution, e.g. CL-0007. */
export function nextClientNumber(existing: Array<{ client_number: string }>): string {
  let max = 0;
  for (const row of existing) {
    const m = /(\d+)\s*$/.exec(row.client_number ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `CL-${String(max + 1).padStart(4, "0")}`;
}
