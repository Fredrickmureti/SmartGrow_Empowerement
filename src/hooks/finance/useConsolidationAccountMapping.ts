/**
 * Group chart of accounts and member-account mapping (Brick 4).
 *
 * A consolidation group aggregates companies that each keep their own chart of
 * accounts. Without a mapping layer, "Bank — KCB" in one company and "Bank —
 * KCB" in another are two unrelated rows, so the consolidated report reads as a
 * list of member accounts rather than a group statement.
 *
 * This module owns the *configuration* of that layer only:
 * - `consolidation_group_accounts` — the group's own chart: code, name, type.
 * - `consolidation_account_mappings` — effective-dated links from a member
 *   company's account to a group account.
 *
 * It computes no figures. Aggregation happens server-side in
 * `get_consolidated_trial_balance_translated` /
 * `get_consolidated_statement_lines`, which refuse to report a period where a
 * member account carrying a balance has no mapping — an unmapped balance would
 * silently drop out of, or duplicate inside, the group totals.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

export type GroupAccountType = "asset" | "liability" | "equity" | "income" | "expense";

export const GROUP_ACCOUNT_TYPES: GroupAccountType[] = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

export const GROUP_ACCOUNT_TYPE_LABELS: Record<GroupAccountType, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  income: "Income",
  expense: "Expense",
};

export interface ConsolidationGroupAccount {
  id: string;
  organization_id: string;
  group_id: string;
  code: string;
  name: string;
  account_type: GroupAccountType;
  sort_order: number;
  is_active: boolean;
  notes: string | null;
}

export interface ConsolidationAccountMapping {
  id: string;
  organization_id: string;
  group_id: string;
  business_id: string;
  account_id: string;
  group_account_id: string;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
}

/** A member company's own account, as offered to the mapping picker. */
export interface MemberAccountOption {
  id: string;
  business_id: string;
  code: string | null;
  name: string;
  account_type: GroupAccountType;
}

/** A posted member account with no group account behind it — a hard blocker. */
export interface UnmappedConsolidationAccount {
  business_id: string;
  business_name: string;
  account_id: string;
  account_code: string | null;
  account_name: string;
  account_type: GroupAccountType;
  closing_balance: number;
}

/** The group's own chart of accounts, in presentation order. */
export function useConsolidationGroupAccounts(groupId: string | null) {
  return useQuery({
    queryKey: ["consolidation-group-accounts", groupId],
    enabled: !!groupId,
    queryFn: async (): Promise<ConsolidationGroupAccount[]> => {
      const { data, error } = await supabase
        .from("consolidation_group_accounts")
        .select(
          "id, organization_id, group_id, code, name, account_type, sort_order, is_active, notes",
        )
        .eq("group_id", groupId!)
        .order("sort_order")
        .order("code");
      if (error) throw error;
      return (data ?? []) as ConsolidationGroupAccount[];
    },
  });
}

/**
 * Every mapping recorded for the group, including closed ones. Closed rows are
 * kept deliberately: a past-period consolidation must stay reproducible under
 * the mapping that was in force at the time.
 */
export function useConsolidationAccountMappings(groupId: string | null) {
  return useQuery({
    queryKey: ["consolidation-account-mappings", groupId],
    enabled: !!groupId,
    queryFn: async (): Promise<ConsolidationAccountMapping[]> => {
      const { data, error } = await supabase
        .from("consolidation_account_mappings")
        .select(
          "id, organization_id, group_id, business_id, account_id, group_account_id, effective_from, effective_to, notes",
        )
        .eq("group_id", groupId!)
        .order("effective_from");
      if (error) throw error;
      return (data ?? []) as ConsolidationAccountMapping[];
    },
  });
}

/**
 * Postable accounts of the given member companies. Header and inactive
 * accounts are excluded because nothing posts to them, so mapping them would
 * be noise the database guard would reject anyway.
 */
export function useConsolidationMemberAccounts(businessIds: string[]) {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;
  const key = [...businessIds].sort().join(",");

  return useQuery({
    queryKey: ["consolidation-member-accounts", orgId, key],
    enabled: !!orgId && businessIds.length > 0,
    queryFn: async (): Promise<MemberAccountOption[]> => {
      const { data, error } = await supabase
        .from("accounts")
        .select("id, business_id, code, name, account_type")
        .eq("organization_id", orgId!)
        .in("business_id", businessIds)
        .eq("is_active", true)
        .eq("is_header", false)
        .order("code");
      if (error) throw error;
      return (data ?? []) as MemberAccountOption[];
    },
  });
}

/**
 * The worklist that stands between a group and a defensible consolidation:
 * member accounts with posted activity in the period that map to nothing.
 * The reporting engine refuses the period while this is non-empty.
 */
export function useConsolidationUnmappedAccounts(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidation-unmapped-accounts", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<UnmappedConsolidationAccount[]> => {
      const { data, error } = await supabase.rpc("consolidation_unmapped_accounts", {
        _group_id: groupId!,
        _date_from: dateFrom!,
        _date_to: dateTo!,
      });
      if (error) throw error;
      return (data ?? []) as UnmappedConsolidationAccount[];
    },
  });
}

export function useConsolidationMappingMutations() {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["consolidation-group-accounts"] });
    queryClient.invalidateQueries({ queryKey: ["consolidation-account-mappings"] });
    queryClient.invalidateQueries({ queryKey: ["consolidation-unmapped-accounts"] });
    queryClient.invalidateQueries({ queryKey: ["consolidated-trial-balance-translated"] });
    queryClient.invalidateQueries({ queryKey: ["consolidated-statement-lines"] });
  };

  const createGroupAccount = useMutation({
    mutationFn: async (input: {
      group_id: string;
      code: string;
      name: string;
      account_type: GroupAccountType;
      sort_order?: number;
    }) => {
      if (!orgId) throw new Error("No active workspace");
      const { data, error } = await supabase
        .from("consolidation_group_accounts")
        .insert({ ...input, organization_id: orgId })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: invalidate,
  });

  /**
   * Only presentation attributes are editable. The account type is structural:
   * changing it would silently move a balance between statements, and the
   * database guard requires mapped member accounts to share the same type.
   */
  const updateGroupAccount = useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: {
      id: string;
      code?: string;
      name?: string;
      sort_order?: number;
      is_active?: boolean;
      notes?: string | null;
    }) => {
      const { error } = await supabase
        .from("consolidation_group_accounts")
        .update(patch)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const deleteGroupAccount = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("consolidation_group_accounts")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const mapAccount = useMutation({
    mutationFn: async (input: {
      group_id: string;
      business_id: string;
      account_id: string;
      group_account_id: string;
      effective_from?: string;
    }) => {
      if (!orgId) throw new Error("No active workspace");
      const { error } = await supabase
        .from("consolidation_account_mappings")
        .insert({ ...input, organization_id: orgId });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const remapAccount = useMutation({
    mutationFn: async ({
      id,
      group_account_id,
    }: {
      id: string;
      group_account_id: string;
    }) => {
      const { error } = await supabase
        .from("consolidation_account_mappings")
        .update({ group_account_id })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  /**
   * Ends a mapping with a date rather than deleting it, so periods already
   * reported keep resolving to the group account they were reported under.
   */
  const closeMapping = useMutation({
    mutationFn: async ({ id, effectiveTo }: { id: string; effectiveTo: string }) => {
      const { error } = await supabase
        .from("consolidation_account_mappings")
        .update({ effective_to: effectiveTo })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  return {
    createGroupAccount,
    updateGroupAccount,
    deleteGroupAccount,
    mapAccount,
    remapAccount,
    closeMapping,
  };
}
