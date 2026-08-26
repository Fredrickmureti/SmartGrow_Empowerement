/**
 * Consolidation group configuration (Brick 1 — group and ownership foundation).
 *
 * These hooks own the *configuration* half of group reporting: which legal
 * entities belong to a group, who owns whom, at what percentage, and under
 * which consolidation method. They deliberately compute NO accounting figures
 * — statements keep coming from the authoritative SQL reporting engine.
 *
 * Scope: a consolidation group spans companies, so these tables are
 * organization-scoped. Row-level security restricts reads to organization
 * members who can access the companies involved, and writes to owners /
 * admins / super admins. The company pickers in the UI are fed from
 * `get_user_allowed_businesses`, never from the raw org company list, so a
 * group can never be defined over a company the caller cannot access.
 *
 * Membership is effective-dated history, not a mutable set: a company leaves a
 * group through `close_consolidation_member` (which stamps `effective_to`),
 * never through a delete, so a past-period consolidation stays reproducible.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";

export type ConsolidationMethod = "full" | "proportional" | "equity" | "excluded";

export interface ConsolidationGroup {
  id: string;
  organization_id: string;
  name: string;
  code: string | null;
  parent_business_id: string;
  presentation_currency: string;
  description: string | null;
  is_active: boolean;
}

export interface ConsolidationGroupMember {
  id: string;
  organization_id: string;
  group_id: string;
  business_id: string;
  parent_business_id: string | null;
  ownership_percent: number;
  method: ConsolidationMethod;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
}

export interface ConsolidationChangeLogEntry {
  id: string;
  group_id: string;
  member_id: string | null;
  business_id: string | null;
  entity: "group" | "member";
  action: "insert" | "update" | "delete";
  actor_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

export const CONSOLIDATION_METHOD_LABELS: Record<ConsolidationMethod, string> = {
  full: "Full consolidation (control)",
  proportional: "Proportional (joint operation)",
  equity: "Equity method (significant influence)",
  excluded: "Excluded from the group",
};

/** Org roles that RLS lets write consolidation configuration. */
const CONSOLIDATION_WRITE_ROLES = ["owner", "admin", "super_admin"] as const;

/**
 * Whether this user may change group configuration. Mirrors the RLS write
 * policy exactly — the UI must not offer an action the database will refuse.
 */
export function useCanManageConsolidation(): boolean {
  const { userRole } = useOrganization();
  return !!userRole && (CONSOLIDATION_WRITE_ROLES as readonly string[]).includes(userRole.role);
}

/**
 * Companies this user may actually read, resolved server-side. The raw
 * `businesses` list is org-scoped only; using it in a picker would let a user
 * declare a group over a company RLS then hides from them.
 */
export function useConsolidationAllowedBusinessIds() {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const orgId = currentOrg?.id;

  return useQuery({
    queryKey: ["consolidation-allowed-businesses", orgId, user?.id],
    enabled: !!orgId && !!user?.id,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase.rpc("get_user_allowed_businesses", {
        _user_id: user!.id,
        _org_id: orgId!,
      });
      if (error) throw error;
      return (data ?? []) as string[];
    },
  });
}

export function useConsolidationGroups() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;

  return useQuery({
    queryKey: ["consolidation-groups", orgId],
    enabled: !!orgId,
    queryFn: async (): Promise<ConsolidationGroup[]> => {
      const { data, error } = await supabase
        .from("consolidation_groups")
        .select(
          "id, organization_id, name, code, parent_business_id, presentation_currency, description, is_active",
        )
        .eq("organization_id", orgId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as ConsolidationGroup[];
    },
  });
}

/**
 * Full effective-dated membership history of a group, newest period last.
 * Closed periods are returned deliberately: hiding them would hide the very
 * history that makes a past-period consolidation reproducible.
 */
export function useConsolidationGroupMembers(groupId: string | null) {
  return useQuery({
    queryKey: ["consolidation-group-members", groupId],
    enabled: !!groupId,
    queryFn: async (): Promise<ConsolidationGroupMember[]> => {
      const { data, error } = await supabase
        .from("consolidation_group_members")
        .select(
          "id, organization_id, group_id, business_id, parent_business_id, ownership_percent, method, effective_from, effective_to, notes",
        )
        .eq("group_id", groupId!)
        .order("effective_from")
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as ConsolidationGroupMember[];
    },
  });
}

/** Append-only configuration audit trail for one group. */
export function useConsolidationChangeLog(groupId: string | null) {
  return useQuery({
    queryKey: ["consolidation-change-log", groupId],
    enabled: !!groupId,
    queryFn: async (): Promise<ConsolidationChangeLogEntry[]> => {
      const { data, error } = await supabase
        .from("consolidation_group_change_log")
        .select(
          "id, group_id, member_id, business_id, entity, action, actor_id, before_state, after_state, created_at",
        )
        .eq("group_id", groupId!)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as ConsolidationChangeLogEntry[];
    },
  });
}

export function useConsolidationGroupMutations() {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["consolidation-groups"] });
    queryClient.invalidateQueries({ queryKey: ["consolidation-group-members"] });
    queryClient.invalidateQueries({ queryKey: ["consolidation-change-log"] });
  };

  const createGroup = useMutation({
    mutationFn: async (input: {
      name: string;
      code?: string | null;
      parent_business_id: string;
      presentation_currency: string;
      description?: string | null;
    }) => {
      if (!orgId) throw new Error("No active workspace");
      const { data, error } = await supabase
        .from("consolidation_groups")
        .insert({ ...input, organization_id: orgId })
        .select("id")
        .single();
      if (error) throw error;

      // The parent company is always a member of its own group, at 100%.
      const { error: memberError } = await supabase
        .from("consolidation_group_members")
        .insert({
          organization_id: orgId,
          group_id: data.id,
          business_id: input.parent_business_id,
          parent_business_id: null,
          ownership_percent: 100,
          method: "full" as ConsolidationMethod,
        });
      if (memberError) throw memberError;
      return data.id as string;
    },
    onSuccess: invalidate,
  });

  const deleteGroup = useMutation({
    mutationFn: async (groupId: string) => {
      const { error } = await supabase
        .from("consolidation_groups")
        .delete()
        .eq("id", groupId);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const addMember = useMutation({
    mutationFn: async (input: {
      group_id: string;
      business_id: string;
      parent_business_id: string | null;
      ownership_percent: number;
      method: ConsolidationMethod;
      effective_from: string;
    }) => {
      if (!orgId) throw new Error("No active workspace");
      const { error } = await supabase
        .from("consolidation_group_members")
        .insert({ ...input, organization_id: orgId });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const updateMember = useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: Pick<ConsolidationGroupMember, "id"> &
      Partial<
        Pick<
          ConsolidationGroupMember,
          "ownership_percent" | "method" | "parent_business_id" | "notes"
        >
      >) => {
      const { error } = await supabase
        .from("consolidation_group_members")
        .update(patch)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  /**
   * Ends a membership by stamping `effective_to` server-side. There is no
   * delete path: erasing a membership would make an already-issued
   * consolidation impossible to reproduce.
   */
  const closeMember = useMutation({
    mutationFn: async ({ id, effectiveTo }: { id: string; effectiveTo: string }) => {
      const { error } = await supabase.rpc("close_consolidation_member", {
        _id: id,
        _effective_to: effectiveTo,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  return { createGroup, deleteGroup, addMember, updateMember, closeMember };
}
