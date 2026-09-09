/**
 * Microfinance groups and membership (C3).
 *
 * Groups are the collection point: a fixed weekly meeting slot, an owning
 * branch and loan officer, and a membership roll. Membership never implies a
 * joint loan — liability stays individual.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";

export type MfGroupStatus = "forming" | "active" | "dormant" | "closed";

export const MF_GROUP_STATUSES: MfGroupStatus[] = [
  "forming",
  "active",
  "dormant",
  "closed",
];

export const MEETING_DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
] as const;

export function meetingDayLabel(day: number | null): string {
  return MEETING_DAYS.find((d) => d.value === day)?.label ?? "—";
}

export interface MfGroup {
  id: string;
  business_id: string;
  branch_id: string;
  group_number: string;
  name: string;
  loan_officer_id: string | null;
  meeting_day: number | null;
  meeting_time: string | null;
  meeting_place: string | null;
  formed_on: string;
  status: MfGroupStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MfGroupMember {
  id: string;
  business_id: string;
  group_id: string;
  client_id: string;
  role_in_group: string;
  joined_on: string;
  exited_on: string | null;
  is_active: boolean;
}

export type MfGroupInput = Partial<
  Omit<MfGroup, "id" | "business_id" | "created_at" | "updated_at">
> & {
  branch_id: string;
  group_number: string;
  name: string;
};

const GROUP_SELECT =
  "id,business_id,branch_id,group_number,name,loan_officer_id,meeting_day,meeting_time,meeting_place,formed_on,status,notes,created_at,updated_at";
const MEMBER_SELECT =
  "id,business_id,group_id,client_id,role_in_group,joined_on,exited_on,is_active";


export function useMfGroups(options?: {
  branchId?: string | null;
  status?: MfGroupStatus | "all";
}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();
  const branchId = options?.branchId ?? null;
  const status = options?.status ?? "all";

  const query = useQuery({
    queryKey: ["mf-groups", businessId, branchId, status],
    queryFn: async () => {
      if (!businessId) return [] as MfGroup[];
      let q = supabase
        .from("mf_groups")
        .select(GROUP_SELECT)
        .eq("business_id", businessId)
        .order("name", { ascending: true });
      if (branchId) q = q.eq("branch_id", branchId);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as MfGroup[];
    },
    enabled: !!businessId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-groups"] });
    queryClient.invalidateQueries({ queryKey: ["mf-group-members"] });
  };

  const createGroup = useMutation({
    mutationFn: async (input: MfGroupInput) => {
      if (!businessId) throw new Error("No institution selected");
      const { data: auth } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("mf_groups")
        .insert({ ...input, business_id: businessId, created_by: auth.user?.id ?? null })
        .select(GROUP_SELECT)
        .single();
      if (error) throw error;
      return data as MfGroup;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Group created");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not create the group")),
  });

  const updateGroup = useMutation({
    mutationFn: async ({ id, ...patch }: Partial<MfGroupInput> & { id: string }) => {
      const { error } = await supabase.from("mf_groups").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Group updated");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not update the group")),
  });

  return {
    groups: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    createGroup,
    updateGroup,
    businessId,
  };
}

/** Membership roll for one group. */
export function useMfGroupMembers(groupId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-group-members", groupId],
    queryFn: async () => {
      if (!groupId) return [] as MfGroupMember[];
      const { data, error } = await supabase
        .from("mf_group_members")
        .select(MEMBER_SELECT)
        .eq("group_id", groupId)
        .order("joined_on", { ascending: true });
      if (error) throw error;
      return (data ?? []) as MfGroupMember[];
    },
    enabled: !!groupId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["mf-group-members"] });

  const addMember = useMutation({
    mutationFn: async (input: {
      businessId: string;
      clientId: string;
      roleInGroup?: string;
    }) => {
      if (!groupId) throw new Error("No group selected");
      const { error } = await supabase.from("mf_group_members").insert({
        business_id: input.businessId,
        group_id: groupId,
        client_id: input.clientId,
        role_in_group: input.roleInGroup ?? "member",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Member added");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not add the member")),
  });

  const setRole = useMutation({
    mutationFn: async (input: { id: string; roleInGroup: string }) => {
      const { error } = await supabase
        .from("mf_group_members")
        .update({ role_in_group: input.roleInGroup })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Role updated");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not update the role")),
  });

  const exitMember = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("mf_group_members")
        .update({
          is_active: false,
          exited_on: new Date().toISOString().slice(0, 10),
          role_in_group: "member",
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Member exited the group");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not exit the member")),
  });

  return {
    members: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    addMember,
    setRole,
    exitMember,
  };
}

/** Next sequential group number, e.g. GRP-0004. */
export function nextGroupNumber(existing: Array<{ group_number: string }>): string {
  let max = 0;
  for (const row of existing) {
    const m = /(\d+)\s*$/.exec(row.group_number ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `GRP-${String(max + 1).padStart(4, "0")}`;
}
