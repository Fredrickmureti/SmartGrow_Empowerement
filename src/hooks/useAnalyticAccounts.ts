import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type AnalyticType = "cost_center" | "project" | "department" | "product_line" | "other";

export interface AnalyticGroup {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AnalyticAccount {
  id: string;
  organization_id: string;
  group_id: string | null;
  code: string | null;
  name: string;
  description: string | null;
  analytic_type: AnalyticType;
  is_active: boolean;
  balance: number;
  created_at: string;
  updated_at: string;
  group?: AnalyticGroup | null;
}

export interface AnalyticDistribution {
  id: string;
  organization_id: string;
  analytic_account_id: string;
  source_type: string;
  source_id: string;
  amount: number;
  percentage: number | null;
  date: string;
  description: string | null;
  created_at: string;
  analytic_account?: AnalyticAccount;
}

export interface CreateAnalyticGroupInput {
  name: string;
  description?: string;
  sort_order?: number;
}

export interface CreateAnalyticAccountInput {
  code?: string;
  name: string;
  description?: string;
  analytic_type?: AnalyticType;
  group_id?: string;
}

export interface CreateDistributionInput {
  analytic_account_id: string;
  source_type: string;
  source_id: string;
  amount: number;
  percentage?: number;
  date: string;
  description?: string;
}

export function useAnalyticAccounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  // Fetch analytic groups
  const { data: groups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ["analytic-groups", organizationId],
    queryFn: async () => {
      if (!organizationId) return [];
      let q = supabase
        .from("analytic_groups")
        .select("*")
        .eq("organization_id", organizationId)
        .order("sort_order", { ascending: true });
      q = q.eq("business_id", businessId);
      const { data, error } = await q;
      if (error) throw error;
      return data as AnalyticGroup[];
    },
    enabled: !!organizationId,
  });

  // Fetch analytic accounts (per-company)
  const { data: accounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ["analytic-accounts", organizationId, businessId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];
      const { data, error } = await supabase
        .from("analytic_accounts")
        .select(`
          *,
          group:analytic_groups(*)
        `)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("code", { ascending: true });
      if (error) throw error;
      return data as AnalyticAccount[];
    },
    enabled: !!organizationId && !!businessId,
  });

  // Create group
  const createGroup = useMutation({
    mutationFn: async (input: CreateAnalyticGroupInput) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("No company selected — analytic groups are per-company");
      const { data, error } = await supabase
        .from("analytic_groups")
        .insert({
          organization_id: organizationId,
          business_id: businessId,
          name: input.name,
          description: input.description || null,
          sort_order: input.sort_order || 0,
        } as any)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["analytic-groups"] });
      toast.success("Analytic group created");
    },
    onError: (error) => {
      toast.error("Failed to create group: " + normalizeError(error).message);
    },
  });

  // Create account
  const createAccount = useMutation({
    mutationFn: async (input: CreateAnalyticAccountInput) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("No company selected — analytic accounts are per-company");
      const { data, error } = await supabase
        .from("analytic_accounts")
        .insert({
          organization_id: organizationId,
          business_id: businessId,
          code: input.code || null,
          name: input.name,
          description: input.description || null,
          analytic_type: input.analytic_type || "cost_center",
          group_id: input.group_id || null,
        } as any)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["analytic-accounts"] });
      toast.success("Analytic account created");
    },
    onError: (error) => {
      toast.error("Failed to create account: " + normalizeError(error).message);
    },
  });

  // Update account
  const updateAccount = useMutation({
    mutationFn: async ({ id, group, ...input }: Partial<AnalyticAccount> & { id: string }) => {
      const { error } = await supabase
        .from("analytic_accounts")
        .update({
          ...input,
          updated_at: new Date().toISOString(),
        } as any)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["analytic-accounts"] });
      toast.success("Analytic account updated");
    },
    onError: (error) => {
      toast.error("Failed to update account: " + normalizeError(error).message);
    },
  });

  // Delete account
  const deleteAccount = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("analytic_accounts")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["analytic-accounts"] });
      toast.success("Analytic account deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete account: " + normalizeError(error).message);
    },
  });

  // Create distribution
  const createDistribution = useMutation({
    mutationFn: async (input: CreateDistributionInput) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("No company selected — analytic distributions are per-company");
      const { data, error } = await supabase
        .from("analytic_distributions")
        .insert({
          organization_id: organizationId,
          business_id: businessId,
          analytic_account_id: input.analytic_account_id,
          source_type: input.source_type,
          source_id: input.source_id,
          amount: input.amount,
          percentage: input.percentage || null,
          date: input.date,
          description: input.description || null,
        } as any)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["analytic-distributions"] });
    },
    onError: (error) => {
      toast.error("Failed to create distribution: " + normalizeError(error).message);
    },
  });

  // Get distributions for a source
  const getDistributions = async (sourceType: string, sourceId: string) => {
    const { data, error } = await supabase
      .from("analytic_distributions")
      .select(`
        *,
        analytic_account:analytic_accounts(*)
      `)
      .eq("source_type", sourceType)
      .eq("source_id", sourceId);
    if (error) throw error;
    return data as AnalyticDistribution[];
  };

  // Get account balance by date range
  const getAccountBalance = async (accountId: string, startDate: string, endDate: string) => {
    const { data, error } = await supabase
      .from("analytic_distributions")
      .select("amount")
      .eq("analytic_account_id", accountId)
      .gte("date", startDate)
      .lte("date", endDate);
    if (error) throw error;
    return data.reduce((sum, d) => sum + d.amount, 0);
  };

  return {
    groups,
    accounts,
    activeAccounts: accounts.filter((a) => a.is_active),
    isLoading: groupsLoading || accountsLoading,
    createGroup,
    createAccount,
    updateAccount,
    deleteAccount,
    createDistribution,
    getDistributions,
    getAccountBalance,
    getAccountsByType: (type: AnalyticType) => accounts.filter((a) => a.analytic_type === type && a.is_active),
  };
}
