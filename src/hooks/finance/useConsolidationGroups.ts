/**
 * Consolidation group configuration (Phase 3 — foundations).
 *
 * These hooks own the *configuration* half of group reporting: which legal
 * entities belong to a group, who owns whom, at what percentage, and under
 * which consolidation method. They deliberately compute NO accounting figures
 * — statements keep coming from the authoritative SQL reporting engine.
 *
 * Scope: a consolidation group spans companies, so these tables are
 * organization-scoped. Row-level security restricts reads to organization
 * members who can access the companies involved, and writes to owners /
 * admins / super admins.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

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

export const CONSOLIDATION_METHOD_LABELS: Record<ConsolidationMethod, string> = {
  full: "Full consolidation (control)",
  proportional: "Proportional (joint operation)",
  equity: "Equity method (significant influence)",
  excluded: "Excluded from the group",
};

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
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as ConsolidationGroupMember[];
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
    }: Partial<ConsolidationGroupMember> & { id: string }) => {
      const { error } = await supabase
        .from("consolidation_group_members")
        .update(patch)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const removeMember = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("consolidation_group_members")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  return { createGroup, deleteGroup, addMember, updateMember, removeMember };
}
