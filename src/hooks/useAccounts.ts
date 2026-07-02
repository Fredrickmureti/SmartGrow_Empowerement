import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useToast } from "./use-toast";
import { getCashFlowCategoryFromDetailType, isValidDetailTypeForAccountType } from "@/lib/accountDetailTypeClassification";

export interface Account {
  id: string;
  organization_id: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  detail_type: string | null;
  cash_flow_category: string | null;
  code: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  is_system: boolean;
  is_active: boolean;
  opening_balance: number;
  current_balance: number;
  /**
   * Canonical accounting role for system-managed accounts
   * (e.g. 'accounts_receivable', 'accounts_payable', 'sales_revenue').
   * Used by AR/AP integrity guards in the manual journal editor.
   */
  system_role: string | null;
  created_at: string;
  updated_at: string;
}

export function useAccounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["accounts", orgId, businessId],
    queryFn: async () => {
      if (!orgId || !businessId) return [];

      const { data, error } = await supabase
        .from("accounts")
        .select("*")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .order("code");

      if (error) throw error;
      return data as Account[];
    },
    enabled: !!orgId && !!businessId,
    staleTime: 30_000,
  });

  const invalidateAccounts = () => {
    queryClient.invalidateQueries({ queryKey: ["accounts", orgId, businessId] });
  };

  const createAccount = async (account: Pick<Account, "account_type" | "code" | "name"> & Partial<Omit<Account, "id" | "organization_id" | "created_at" | "updated_at" | "account_type" | "code" | "name">>) => {
    if (!orgId || !businessId) throw new Error("No organization or business selected");

    // Validate detail_type matches account_type
    if (account.detail_type && !isValidDetailTypeForAccountType(account.detail_type, account.account_type)) {
      console.warn(`⚠️ detail_type "${account.detail_type}" does not match account_type "${account.account_type}". Clearing detail_type.`);
      account = { ...account, detail_type: null };
    }

    // Auto-derive cash_flow_category from detail_type if not explicitly set
    const cashFlowCategory = account.detail_type
      ? getCashFlowCategoryFromDetailType(account.detail_type)
      : null;

    // SAFEGUARD: Warn if creating equity account without opening balance
    if (account.account_type === "equity" && (!account.opening_balance || account.opening_balance === 0)) {
      console.warn(`⚠️ Creating equity account "${account.name}" with zero opening_balance.`);
    }

    const { data, error } = await supabase
      .from("accounts")
      .insert({
        opening_balance: 0,
        ...account,
        organization_id: orgId,
        business_id: businessId,
        cash_flow_category: account.detail_type ? cashFlowCategory : undefined,
      })
      .select()
      .single();

    if (error) throw error;

    // If opening_balance was set, auto-migrate it to a journal entry
    const ob = account.opening_balance || 0;
    if (ob !== 0) {
      try {
        await supabase.rpc("migrate_opening_balances_to_je", {
          _org_id: orgId,
          _business_id: businessId,
          _entry_date: new Date().toISOString().split("T")[0],
        });
      } catch (migrationError: any) {
        console.warn("⚠️ Auto-migration of opening balance failed:", migrationError.message);
      }
    }

    invalidateAccounts();
    return data;
  };

  const updateAccount = async (id: string, updates: Partial<Account>) => {
    // SAFETY GUARD: Block account_type changes if journal entries exist
    if (updates.account_type) {
      const existing = accounts.find(a => a.id === id);
      if (existing && updates.account_type !== existing.account_type) {
        const { count, error: countError } = await supabase
          .from("journal_entry_lines")
          .select("*", { count: "exact", head: true })
          .eq("account_id", id);

        if (!countError && count && count > 0) {
          throw new Error(
            `Cannot change account type — ${count} transaction${count > 1 ? 's' : ''} exist on this account. ` +
            `Create a new account with the desired type and transfer the balance via journal entry instead.`
          );
        }
      }
    }

    // Validate detail_type matches account_type on update
    if (updates.detail_type && updates.account_type) {
      if (!isValidDetailTypeForAccountType(updates.detail_type, updates.account_type)) {
        console.warn(`⚠️ detail_type "${updates.detail_type}" does not match account_type "${updates.account_type}". Clearing detail_type.`);
        updates = { ...updates, detail_type: null };
      }
    }

    // Auto-derive cash_flow_category if detail_type changed
    if (updates.detail_type !== undefined) {
      const cashFlowCategory = getCashFlowCategoryFromDetailType(updates.detail_type);
      (updates as any).cash_flow_category = cashFlowCategory;
    }

    const { error } = await supabase
      .from("accounts")
      .update(updates)
      .eq("id", id);

    if (error) throw error;
    invalidateAccounts();
  };

  const deleteAccount = async (id: string) => {
    const { error, status } = await supabase.from("accounts").delete().eq("id", id);
    if (error) {
      if (status === 409 || error.code === '23503') {
        throw new Error("This account has transactions or is referenced by other records and cannot be deleted. You can archive it instead.");
      }
      throw error;
    }
    invalidateAccounts();
  };

  const archiveAccount = async (id: string) => {
    const { error } = await supabase
      .from("accounts")
      .update({ is_active: false })
      .eq("id", id);
    if (error) throw error;
    invalidateAccounts();
  };

  const restoreAccount = async (id: string) => {
    const { error } = await supabase
      .from("accounts")
      .update({ is_active: true })
      .eq("id", id);
    if (error) throw error;
    invalidateAccounts();
  };

  const getAccountsByType = (type: Account["account_type"]) => {
    return accounts.filter((a) => a.account_type === type);
  };

  return {
    accounts,
    isLoading,
    createAccount,
    updateAccount,
    deleteAccount,
    archiveAccount,
    restoreAccount,
    getAccountsByType,
    refreshAccounts: invalidateAccounts,
  };
}
