import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { normalizeError } from "@/services/resilience";

export interface BranchAssignment {
  id: string;
  user_id: string;
  organization_id: string;
  business_id: string;
  branch_id: string;
  is_primary: boolean;
  can_view: boolean;
  can_manage: boolean;
  created_at: string;
  updated_at: string;
  branch?: {
    id: string;
    name: string;
    code: string | null;
    is_headquarters: boolean;
  };
}

export interface CreateBranchAssignmentInput {
  user_id: string;
  branch_id: string;
  is_primary?: boolean;
  can_view?: boolean;
  can_manage?: boolean;
}

export function useBranchAssignments(userId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Fetch assignments for a specific user
  const { data: assignments = [], isLoading, refetch } = useQuery({
    queryKey: ["branch-assignments", userId, currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg || !userId) return [];

      let query = supabase
        .from("user_branch_assignments")
        .select(`
          *,
          branch:branches(id, name, code, is_headquarters)
        `)
        .eq("user_id", userId)
        .eq("organization_id", currentOrg.id);

      if (currentBusiness) {
        query = query.eq("business_id", currentBusiness.id);
      }

      const { data, error } = await query.order("is_primary", { ascending: false });

      if (error) throw error;
      return data as BranchAssignment[];
    },
    enabled: !!currentOrg && !!userId,
  });

  // Create or update branch assignments for a user
  const updateAssignmentsMutation = useMutation({
    mutationFn: async ({
      targetUserId,
      branchAssignments,
    }: {
      targetUserId: string;
      branchAssignments: {
        branchId: string;
        isPrimary: boolean;
        canManage: boolean;
      }[];
    }) => {
      if (!currentOrg || !currentBusiness) {
        throw new Error("No organization or business selected");
      }

      // First, delete existing assignments for this user in this business
      const { error: deleteError } = await supabase
        .from("user_branch_assignments")
        .delete()
        .eq("user_id", targetUserId)
        .eq("business_id", currentBusiness.id);

      if (deleteError) throw deleteError;

      // If no branches selected, we're done
      if (branchAssignments.length === 0) {
        return [];
      }

      // Insert new assignments
      const insertData = branchAssignments.map((ba) => ({
        user_id: targetUserId,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: ba.branchId,
        is_primary: ba.isPrimary,
        can_view: true,
        can_manage: ba.canManage,
        assigned_by: user?.id,
      }));

      const { data, error } = await supabase
        .from("user_branch_assignments")
        .insert(insertData)
        .select();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Branch assignments updated");
      queryClient.invalidateQueries({ queryKey: ["branch-assignments"] });
    },
    onError: (error: any) => {
      console.error("Error updating branch assignments:", error);
      toast.error(normalizeError(error).message || "Failed to update branch assignments");
    },
  });

  // Get all users with their branch assignments for a business
  const { data: allUserAssignments = [], isLoading: isLoadingAll, refetch: refetchAll } = useQuery({
    queryKey: ["all-branch-assignments", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg || !currentBusiness) return [];

      const { data, error } = await supabase
        .from("user_branch_assignments")
        .select(`
          *,
          branch:branches(id, name, code, is_headquarters)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);

      if (error) throw error;
      return data as BranchAssignment[];
    },
    enabled: !!currentOrg && !!currentBusiness,
  });

  // Group assignments by user
  const assignmentsByUser = allUserAssignments.reduce((acc, assignment) => {
    if (!acc[assignment.user_id]) {
      acc[assignment.user_id] = [];
    }
    acc[assignment.user_id].push(assignment);
    return acc;
  }, {} as Record<string, BranchAssignment[]>);

  return {
    assignments,
    isLoading,
    refetch,
    updateAssignments: updateAssignmentsMutation.mutate,
    isUpdating: updateAssignmentsMutation.isPending,
    allUserAssignments,
    assignmentsByUser,
    isLoadingAll,
    refetchAll,
  };
}
