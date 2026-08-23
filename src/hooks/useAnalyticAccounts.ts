/**
 * Analytic master data (plans → accounts → groups).
 *
 * Model note: the axis ("cost center", "department", "project", "product
 * line") is data — a row in `analytic_plans` — not an enum on the account.
 * That is what allows one posted journal line to carry one value per axis.
 *
 * Attribution itself is NOT written from here. `analytic_distributions` is a
 * read-only projection of what the posting engine wrote on the journal lines;
 * the client has no INSERT/UPDATE/DELETE grant on it by design.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type AnalyticStatus = "draft" | "active" | "restricted" | "archived";

export interface AnalyticPlan {
  id: string;
  organization_id: string;
  business_id: string;
  code: string;
  name: string;
  description: string | null;
  is_required: boolean;
  is_active: boolean;
  sort_order: number;
}

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
  business_id: string;
  plan_id: string;
  group_id: string | null;
  parent_id: string | null;
  code: string | null;
  name: string;
  description: string | null;
  status: AnalyticStatus;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  group?: AnalyticGroup | null;
  plan?: AnalyticPlan | null;
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
  plan_id: string;
  group_id?: string;
  status?: AnalyticStatus;
}

/** An account that may still be attributed on a new posting. */
export function isPostable(account: Pick<AnalyticAccount, "status">): boolean {
  return account.status === "active";
}

export function useAnalyticAccounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const { data: plans = [], isLoading: plansLoading } = useQuery({
    queryKey: ["analytic-plans", organizationId, businessId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];
      const { data, error } = await supabase
        .from("analytic_plans")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as AnalyticPlan[];
    },
    enabled: !!organizationId && !!businessId,
  });

  const { data: groups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ["analytic-groups", organizationId, businessId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];
      const { data, error } = await supabase
        .from("analytic_groups")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as AnalyticGroup[];
    },
    enabled: !!organizationId && !!businessId,
  });

  const { data: accounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ["analytic-accounts", organizationId, businessId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];
      const { data, error } = await supabase
        .from("analytic_accounts")
        .select("*, group:analytic_groups(*), plan:analytic_plans(*)")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("code", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as AnalyticAccount[];
    },
    enabled: !!organizationId && !!businessId,
  });

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
        } as never)
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

  const createAccount = useMutation({
    mutationFn: async (input: CreateAnalyticAccountInput) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("No company selected — analytic accounts are per-company");
      if (!input.plan_id) throw new Error("An analytic plan is required");
      const { data, error } = await supabase
        .from("analytic_accounts")
        .insert({
          organization_id: organizationId,
          business_id: businessId,
          plan_id: input.plan_id,
          code: input.code || null,
          name: input.name,
          description: input.description || null,
          status: input.status ?? "active",
          group_id: input.group_id || null,
        } as never)
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

  const updateAccount = useMutation({
    mutationFn: async ({
      id,
      group: _group,
      plan: _plan,
      ...input
    }: Partial<AnalyticAccount> & { id: string }) => {
      const { error } = await supabase
        .from("analytic_accounts")
        .update({ ...input, updated_at: new Date().toISOString() } as never)
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

  /** Archival is the correct end-of-life for master data with posted history. */
  const archiveAccount = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("analytic_accounts")
        .update({ status: "archived", is_active: false, updated_at: new Date().toISOString() } as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["analytic-accounts"] });
      toast.success("Analytic account archived");
    },
    onError: (error) => {
      toast.error("Failed to archive account: " + normalizeError(error).message);
    },
  });

  /** Only ever succeeds for an account that was never attributed — the
   *  database rejects the delete otherwise. */
  const deleteAccount = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("analytic_accounts").delete().eq("id", id);
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

  const getDistributions = async (sourceType: string, sourceId: string) => {
    const { data, error } = await supabase
      .from("analytic_distributions")
      .select("*")
      .eq("source_type", sourceType)
      .eq("source_id", sourceId);
    if (error) throw error;
    return (data ?? []) as unknown as AnalyticDistribution[];
  };

  const activeAccounts = accounts.filter(isPostable);

  return {
    plans,
    groups,
    accounts,
    activeAccounts,
    isLoading: plansLoading || groupsLoading || accountsLoading,
    createGroup,
    createAccount,
    updateAccount,
    archiveAccount,
    deleteAccount,
    getDistributions,
    /** Postable accounts on a given axis, by plan code (e.g. "cost_center"). */
    getAccountsByPlanCode: (planCode: string) =>
      activeAccounts.filter((a) => a.plan?.code === planCode),
  };
}
