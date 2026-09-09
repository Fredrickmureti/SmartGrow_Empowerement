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
import { lendingErrorMessage } from "@/lib/lending/lendingError";

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
  photo_path: string | null;
  id_front_path: string | null;
  id_back_path: string | null;
  kin_id_front_path: string | null;
  kin_id_back_path: string | null;
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
  /** Assigned server-side by the numbering trigger; never sent on create. */
  client_number?: string;
  full_name: string;
  /**
   * Optional group to join at registration. Handled by `mf_register_client` in
   * the same transaction as the client, so a client is never left half-assigned.
   */
  group_id?: string | null;
  /**
   * The group meeting this client was registered at, when onboarding happened
   * in the field. Stamped by `mf_register_client`, which refuses a meeting from
   * another institution, another group, or one already closed.
   */
  onboarded_meeting_id?: string | null;
};


const SELECT =
  "id,business_id,branch_id,client_number,full_name,national_id,date_of_birth,gender,phone,email,physical_address,occupation,business_type,business_location,next_of_kin_name,next_of_kin_relationship,next_of_kin_phone,photo_path,id_front_path,id_back_path,kin_id_front_path,kin_id_back_path,loan_officer_id,joined_on,status,completed_cycles,notes,created_at,updated_at";

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
      return (data ?? []) as unknown as MfClient[];
    },
    enabled: !!businessId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-clients"] });
  };

  const createClient = useMutation({
    mutationFn: async (input: MfClientInput) => {
      if (!businessId) throw new Error("No institution selected");
      const { group_id, onboarded_meeting_id, ...client } = input;
      // One server operation owns both the client and the group membership, so
      // a failure leaves nothing behind. Cast until the generated Database
      // types pick up the function.
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: unknown }>)("mf_register_client", {
        p_business_id: businessId,
        p_client: client,
        p_group_id: group_id ?? null,
        p_meeting_id: onboarded_meeting_id ?? null,
      });

      if (error) throw error;
      return (Array.isArray(data) ? data[0] : data) as MfClient;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Client registered");
    },
    onError: (e: unknown) => {
      toast.error(lendingErrorMessage(e, "Could not register the client"));
    },
  });

  const updateClient = useMutation({
    mutationFn: async ({ id, ...patch }: Partial<MfClientInput> & { id: string }) => {
      const { error } = await supabase.from("mf_clients").update(patch as never).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Client updated");
    },
    onError: (e: unknown) => {
      toast.error(lendingErrorMessage(e, "Could not update the client"));
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

/* ------------------------------------------------------------------ */
/* KYC images — private `mf-kyc` bucket, filed under business/client. */
/* ------------------------------------------------------------------ */

export type MfKycKind =
  | "photo"
  | "id_front"
  | "id_back"
  | "kin_id_front"
  | "kin_id_back";

export const MF_KYC_COLUMN: Record<MfKycKind, keyof MfClient> = {
  photo: "photo_path",
  id_front: "id_front_path",
  id_back: "id_back_path",
  kin_id_front: "kin_id_front_path",
  kin_id_back: "kin_id_back_path",
};

const KYC_BUCKET = "mf-kyc";

/** Uploads (or replaces) one KYC image and returns its storage path. */
export async function uploadKycImage(
  businessId: string,
  clientId: string,
  kind: MfKycKind,
  file: Blob,
): Promise<string> {
  const path = `${businessId}/${clientId}/${kind}.jpg`;
  const { error } = await supabase.storage
    .from(KYC_BUCKET)
    .upload(path, file, { upsert: true, contentType: "image/jpeg", cacheControl: "0" });
  if (error) throw error;
  return path;
}

export async function removeKycImage(path: string): Promise<void> {
  const { error } = await supabase.storage.from(KYC_BUCKET).remove([path]);
  if (error) throw error;
}

/** Short-lived signed URL for a stored KYC image (private bucket). */
export function useKycImageUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ["mf-kyc-url", path],
    enabled: !!path,
    staleTime: 50 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(KYC_BUCKET)
        .createSignedUrl(path!, 60 * 60);
      if (error) throw error;
      return data.signedUrl;
    },
  });
}
