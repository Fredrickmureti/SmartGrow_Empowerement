import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useToast } from "@/hooks/use-toast";
import { PermissionModule } from "@/lib/permissions";
import { normalizeError } from "@/services/resilience";

export interface PermissionGroup {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface PermissionGroupRule {
  id: string;
  permission_group_id: string;
  module: PermissionModule;
  can_read: boolean;
  can_create: boolean;
  can_write: boolean;
  can_delete: boolean;
  /** ERP maker-checker: approve drafts (timesheets, leave, JEs, payroll). */
  can_approve: boolean;
  /** Post draft → posted (JEs, payroll runs, invoices). Separates author from poster. */
  can_post: boolean;
  /** Disburse cash (payroll payment batches, AP payments). Separates poster from payer. */
  can_pay: boolean;
  /** Export sensitive data (payroll, GL, reports). SOX-style separation. */
  can_export: boolean;
  /** Bypass maker-checker (e.g. allow creator to also approve payroll). Owner/super_admin/admin already bypass. */
  can_admin_override: boolean;
}

/** Shape used by create/update mutations — same as rule minus auto-fields. */
export type PermissionGroupRuleInput = {
  module: PermissionModule;
  can_read: boolean;
  can_create: boolean;
  can_write: boolean;
  can_delete: boolean;
  can_approve: boolean;
  can_post: boolean;
  can_pay: boolean;
  can_export: boolean;
  can_admin_override: boolean;
};

export interface PermissionGroupWithRules extends PermissionGroup {
  rules: PermissionGroupRule[];
}

export interface MemberPermissionGroup {
  id: string;
  organization_id: string;
  user_id: string;
  permission_group_id: string;
  created_at: string;
}

export function usePermissionGroups() {
  const { currentOrg } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  // NOTE: Access Groups are WORKSPACE-scoped (Odoo res.groups behaviour).
  // Do NOT filter by business_id here — the table holds workspace-wide rows
  // (business_id is always NULL after the Stage 2 migration). Filtering by
  // a current business silently empties the page when a workspace has more
  // than one business.
  const { data: groups = [], isLoading } = useQuery({
    queryKey: ["permission-groups", orgId],
    queryFn: async () => {
      if (!orgId) return [];

      const { data: groupsData, error: groupsError } = await supabase
        .from("permission_groups")
        .select("*")
        .eq("organization_id", orgId)
        .order("is_system", { ascending: false })
        .order("name");

      if (groupsError) throw groupsError;

      const { data: rulesData, error: rulesError } = await supabase
        .from("permission_group_rules")
        .select("*")
        .in("permission_group_id", groupsData.map(g => g.id));

      if (rulesError) throw rulesError;

      return groupsData.map(group => ({
        ...group,
        rules: (rulesData || []).filter(r => r.permission_group_id === group.id),
      })) as PermissionGroupWithRules[];
    },
    enabled: !!orgId,
  });

  // Member assignments are also workspace-scoped.
  const { data: memberAssignments = [] } = useQuery({
    queryKey: ["member-permission-groups", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("member_permission_groups")
        .select("*")
        .eq("organization_id", orgId);
      if (error) throw error;
      return data as MemberPermissionGroup[];
    },
    enabled: !!orgId,
  });

  // Create permission group
  const createGroup = useMutation({
    mutationFn: async (input: { name: string; description?: string; rules: Array<PermissionGroupRuleInput> }) => {
      if (!orgId) throw new Error("No organization selected");

      const { data: group, error: groupError } = await supabase
        .from("permission_groups")
        .insert({ organization_id: orgId, name: input.name, description: input.description || null })
        .select()
        .single();

      if (groupError) throw groupError;

      if (input.rules.length > 0) {
        const { error: rulesError } = await supabase
          .from("permission_group_rules")
          .insert(input.rules.map(r => ({ permission_group_id: group.id, ...r })));
        if (rulesError) throw rulesError;
      }

      return group;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["permission-groups", orgId] });
      toast({ title: "Access group created" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  // Update permission group
  const updateGroup = useMutation({
    mutationFn: async (input: { id: string; name: string; description?: string; rules: Array<PermissionGroupRuleInput> }) => {
      const { error: updateError } = await supabase
        .from("permission_groups")
        .update({ name: input.name, description: input.description || null })
        .eq("id", input.id);

      if (updateError) throw updateError;

      // Delete existing rules and re-insert
      await supabase.from("permission_group_rules").delete().eq("permission_group_id", input.id);

      if (input.rules.length > 0) {
        const { error: rulesError } = await supabase
          .from("permission_group_rules")
          .insert(input.rules.map(r => ({ permission_group_id: input.id, ...r })));
        if (rulesError) throw rulesError;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["permission-groups", orgId] });
      toast({ title: "Access group updated" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  // Delete permission group
  const deleteGroup = useMutation({
    mutationFn: async (groupId: string) => {
      const { error } = await supabase
        .from("permission_groups")
        .delete()
        .eq("id", groupId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["permission-groups", orgId] });
      toast({ title: "Access group deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  // Assign groups to a member
  const assignGroups = useMutation({
    mutationFn: async ({ userId, groupIds }: { userId: string; groupIds: string[] }) => {
      if (!orgId) throw new Error("No organization selected");

      // Guard: block assignment to portal users
      const { data: userRole } = await supabase
        // SCOPE-EXEMPT: `user_roles` is workspace-wide (no business_id column)
        .from("user_roles")
        .select("user_type")
        .eq("user_id", userId)
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .maybeSingle();

      if (userRole?.user_type === "portal") {
        throw new Error("Access Groups cannot be assigned to portal users. Promote them to an internal user first.");
      }

      // Remove existing assignments (workspace-scoped — no business_id filter).
      await supabase
        .from("member_permission_groups")
        .delete()
        .eq("organization_id", orgId)
        .eq("user_id", userId);

      // Insert new assignments
      if (groupIds.length > 0) {
        const { error } = await supabase
          .from("member_permission_groups")
          .insert(groupIds.map(gId => ({ organization_id: orgId, user_id: userId, permission_group_id: gId })));
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["member-permission-groups", orgId] });
      toast({ title: "Group assignments updated" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  const getGroupsForUser = (userId: string) => {
    const assignments = memberAssignments.filter(a => a.user_id === userId);
    return groups.filter(g => assignments.some(a => a.permission_group_id === g.id));
  };

  return {
    groups,
    isLoading,
    memberAssignments,
    createGroup,
    updateGroup,
    deleteGroup,
    assignGroups,
    getGroupsForUser,
  };
}
