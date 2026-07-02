import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface POSCashier {
  id: string;
  organization_id: string;
  user_id: string;
  employee_number: string | null;
  display_name: string;
  is_active: boolean;
  can_void_transactions: boolean;
  can_apply_discounts: boolean;
  can_process_returns: boolean;
  can_open_cash_drawer: boolean;
  max_discount_percent: number;
  max_void_amount: number;
  created_at: string;
  updated_at: string;
  // Joined data
  user_email?: string;
  assigned_registers?: Array<{
    id: string;
    register_id: string;
    register_name: string;
    is_primary: boolean;
  }>;
}

export interface CashierRegisterAssignment {
  id: string;
  cashier_id: string;
  register_id: string;
  is_primary: boolean;
  assigned_at: string;
}

interface CreateCashierData {
  user_id?: string; // Optional - for standalone cashiers
  display_name: string;
  employee_number?: string;
  can_void_transactions?: boolean;
  can_apply_discounts?: boolean;
  can_process_returns?: boolean;
  can_open_cash_drawer?: boolean;
  max_discount_percent?: number;
  max_void_amount?: number;
  register_ids?: string[];
  /**
   * Branch this cashier is pinned to. Required by DB (pos_cashiers.branch_id NOT NULL).
   * If omitted, the hook will derive it from the first register in `register_ids`.
   */
  branch_id?: string;
}

interface UpdateCashierData extends Partial<CreateCashierData> {
  id: string;
  is_active?: boolean;
}

export function usePOSCashiers() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // Stage B: cashier picker is branch-scoped so a Branch A operator
  // cannot accidentally assign or sign in a cashier pinned to Branch B.
  const { currentBranch } = useBranch();
  const { canOversee } = usePOSOverseer();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Fetch all cashiers for the organization
  const { data: cashiers = [], isLoading: isLoadingCashiers } = useQuery({
    queryKey: ["pos-cashiers", currentOrg?.id, currentBusiness?.id, currentBranch?.id ?? null, canOversee],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      // Stage B4: no-branch state only yields rows for overseers.
      if (!currentBranch?.id && !canOversee) return [];

      // Fetch cashiers without profile join (user_id can be null for standalone cashiers).
      // pos_cashiers is company-scoped (Phase B): a cashier belongs to one Company in
      // the workspace; cross-company assignments are not allowed.
      let cashierQuery = supabase
        .from("pos_cashiers")
        .select(`
          *,
          pos_cashier_registers (
            id,
            register_id,
            is_primary,
            pos_registers:register_id (register_name)
          )
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);
      if (currentBranch?.id) {
        cashierQuery = cashierQuery.eq("branch_id", currentBranch.id);
      }
      const { data, error } = await cashierQuery.order("display_name");

      if (error) throw error;

      // Fetch profiles separately for cashiers with user_id
      const cashiersWithUserId = (data || []).filter(c => c.user_id);
      const userIds = cashiersWithUserId.map(c => c.user_id);
      
      let profilesMap: Record<string, { email: string; full_name: string | null }> = {};
      
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          // SCOPE-EXEMPT: `profiles` is workspace-wide (no business_id column)
          .from("profiles")
          .select("user_id, email, full_name")
          .in("user_id", userIds);
        
        profilesMap = (profiles || []).reduce((acc, p) => {
          acc[p.user_id] = { email: p.email, full_name: p.full_name };
          return acc;
        }, {} as Record<string, { email: string; full_name: string | null }>);
      }

      return (data || []).map((cashier: any) => ({
        ...cashier,
        user_email: cashier.user_id ? profilesMap[cashier.user_id]?.email : null,
        assigned_registers: (cashier.pos_cashier_registers || []).map((pcr: any) => ({
          id: pcr.id,
          register_id: pcr.register_id,
          register_name: pcr.pos_registers?.register_name || "Unknown",
          is_primary: pcr.is_primary,
        })),
      })) as POSCashier[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // Fetch available team members (who can be assigned as cashiers)
  const { data: availableUsers = [] } = useQuery({
    queryKey: ["pos-available-users", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];

      // Get users in the organization who aren't already cashiers
      const { data: roles, error: rolesError } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true);

      if (rolesError) throw rolesError;

      const userIds = (roles || []).map(r => r.user_id);
      
      if (userIds.length === 0) return [];

      // Get profiles
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("user_id, email, full_name")
        .in("user_id", userIds);

      if (profilesError) throw profilesError;

      // Filter out existing cashiers
      const existingCashierUserIds = cashiers.map(c => c.user_id);
      
      return (profiles || [])
        .filter(p => !existingCashierUserIds.includes(p.user_id))
        .map(p => ({
          user_id: p.user_id,
          email: p.email,
          full_name: p.full_name,
        }));
    },
    enabled: !!currentOrg?.id && cashiers !== undefined,
  });

  // Create cashier
  const createCashier = useMutation({
    mutationFn: async (data: CreateCashierData) => {
      if (!currentOrg?.id || !user?.id) throw new Error("Not authenticated");
      if (!currentBusiness?.id) throw new Error("Select a Company before creating cashiers");

      // Derive branch_id (required NOT NULL on pos_cashiers) from the first assigned register if not provided
      let branchId = data.branch_id ?? null;
      if (!branchId && data.register_ids && data.register_ids.length > 0) {
        const { data: reg } = await supabase
          .from("pos_registers")
          .select("branch_id")
          .eq("id", data.register_ids[0])
          .maybeSingle();
        branchId = (reg as any)?.branch_id ?? null;
      }
      if (!branchId) {
        throw new Error("Cashier must be assigned to a branch (provide branch_id or at least one register).");
      }

      // Create cashier - user_id is optional for standalone cashiers
      const { data: cashier, error } = await supabase
        .from("pos_cashiers")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          branch_id: branchId,
          user_id: data.user_id || null,
          display_name: data.display_name,
          employee_number: data.employee_number || null,
          can_void_transactions: data.can_void_transactions ?? false,
          can_apply_discounts: data.can_apply_discounts ?? false,
          can_process_returns: data.can_process_returns ?? false,
          can_open_cash_drawer: data.can_open_cash_drawer ?? false,
          max_discount_percent: data.max_discount_percent ?? 0,
          max_void_amount: data.max_void_amount ?? 0,
          created_by: user.id,
        })
        .select()
        .single();

      if (error) throw error;

      // Assign registers if provided
      if (data.register_ids && data.register_ids.length > 0) {
        const assignments = data.register_ids.map((registerId, index) => ({
          cashier_id: cashier.id,
          register_id: registerId,
          business_id: currentBusiness.id,
          is_primary: index === 0,
          assigned_by: user.id,
        }));

        const { error: assignError } = await supabase
          .from("pos_cashier_registers")
          .insert(assignments);

        if (assignError) throw assignError;
      }

      // Update user role to cashier if they have a user_id and don't have a higher role
      if (data.user_id) {
        const { data: existingRole } = await supabase
          // SCOPE-EXEMPT: `user_roles` is workspace-wide (no business_id column)
          .from("user_roles")
          .select("role")
          .eq("organization_id", currentOrg.id)
          .eq("user_id", data.user_id)
          .single();

        if (existingRole && ['viewer'].includes(existingRole.role)) {
          await supabase
            .from("user_roles")
            .update({ role: 'cashier' })
            .eq("organization_id", currentOrg.id)
            .eq("user_id", data.user_id);
        }
      }

      return cashier;
    },
    onSuccess: () => {
      toast.success("Cashier created successfully");
      queryClient.invalidateQueries({ queryKey: ["pos-cashiers"] });
      queryClient.invalidateQueries({ queryKey: ["pos-available-users"] });
    },
    onError: (error: any) => {
      toast.error(normalizeError(error).message || "Failed to create cashier");
    },
  });

  // Update cashier
  const updateCashier = useMutation({
    mutationFn: async (data: UpdateCashierData) => {
      const { id, register_ids, ...updates } = data;

      const { error } = await supabase
        .from("pos_cashiers")
        .update(updates)
        .eq("id", id);

      if (error) throw error;

      // Handle register assignments if provided
      if (register_ids !== undefined) {
        // Remove existing assignments
        await supabase
          .from("pos_cashier_registers")
          .delete()
          .eq("cashier_id", id);

        // Add new assignments
        if (register_ids.length > 0) {
          if (!currentBusiness?.id) throw new Error("Select a Company before assigning registers");
          const assignments = register_ids.map((registerId, index) => ({
            cashier_id: id,
            register_id: registerId,
            business_id: currentBusiness.id,
            is_primary: index === 0,
            assigned_by: user?.id,
          }));

          const { error: assignError } = await supabase
            .from("pos_cashier_registers")
            .insert(assignments);

          if (assignError) throw assignError;
        }
      }

      return { id };
    },
    onSuccess: () => {
      toast.success("Cashier updated successfully");
      queryClient.invalidateQueries({ queryKey: ["pos-cashiers"] });
    },
    onError: (error: any) => {
      toast.error(normalizeError(error).message || "Failed to update cashier");
    },
  });

  // Disable/Enable cashier (locks their sessions)
  const toggleCashierStatus = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from("pos_cashiers")
        .update({ is_active })
        .eq("id", id);

      if (error) throw error;

      // If disabling, lock all active sessions
      if (!is_active) {
        await supabase.rpc("lock_cashier_session", {
          p_cashier_id: id,
          p_reason: "Account disabled by manager",
        });
      }

      return { id, is_active };
    },
    onSuccess: (_, { is_active }) => {
      toast.success(is_active ? "Cashier enabled" : "Cashier disabled and sessions locked");
      queryClient.invalidateQueries({ queryKey: ["pos-cashiers"] });
    },
    onError: (error: any) => {
      toast.error(normalizeError(error).message || "Failed to update cashier status");
    },
  });

  // Set cashier PIN
  const setCashierPin = useMutation({
    mutationFn: async ({ cashier_id, pin }: { cashier_id: string; pin: string }) => {
      const { data, error } = await supabase.rpc("set_cashier_pin", {
        p_cashier_id: cashier_id,
        p_pin: pin,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Cashier PIN updated");
    },
    onError: (error: any) => {
      toast.error(normalizeError(error).message || "Failed to set PIN");
    },
  });

  // Delete cashier
  const deleteCashier = useMutation({
    mutationFn: async (id: string) => {
      // Force end all sessions first
      await supabase.rpc("force_end_cashier_sessions", {
        p_cashier_id: id,
        p_ended_by: user?.id,
      });

      const { error } = await supabase
        .from("pos_cashiers")
        .delete()
        .eq("id", id);

      if (error) throw error;
      return { id };
    },
    onSuccess: () => {
      toast.success("Cashier removed");
      queryClient.invalidateQueries({ queryKey: ["pos-cashiers"] });
      queryClient.invalidateQueries({ queryKey: ["pos-available-users"] });
    },
    onError: (error: any) => {
      toast.error(normalizeError(error).message || "Failed to remove cashier");
    },
  });

  return {
    cashiers,
    isLoadingCashiers,
    availableUsers,
    createCashier,
    updateCashier,
    toggleCashierStatus,
    setCashierPin,
    deleteCashier,
  };
}
