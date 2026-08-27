/**
 * Intercompany identification (Brick 6).
 *
 * Consolidation cannot eliminate what it cannot identify. This module owns the
 * *declaration* layer and the *reconciliation read* — nothing else:
 *
 * - `consolidation_intercompany_partners` — an explicit, effective-dated link
 *   saying "this contact, in this member company, IS that other member
 *   company". Declarations are made by a person and audited in
 *   `consolidation_group_change_log`. Intercompany status is never inferred
 *   from names, codes or descriptions.
 * - `consolidation_intercompany_balances` — the server engine that pairs each
 *   declared relationship's due-from position against the counterparty's
 *   due-to position, both restated into the group's presentation currency at
 *   the group's own closing rate, and reports the difference when the two
 *   sides disagree.
 *
 * DELIBERATELY OUT OF SCOPE HERE
 * ------------------------------
 * No elimination entries are produced or posted, and no figure on the
 * consolidated statements is altered by anything in this file. A mismatched
 * pair is a finding to be investigated by an accountant, not a rounding to be
 * absorbed. Eliminations get their own brick, on top of these declarations.
 *
 * All arithmetic — balances, translation, differences — happens in SQL. Never
 * accumulate intercompany positions in the browser.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

export interface ConsolidationIntercompanyPartner {
  id: string;
  organization_id: string;
  group_id: string;
  business_id: string;
  contact_id: string;
  counterparty_business_id: string;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
}

/** A contact of a member company, as offered to the declaration picker. */
export interface MemberContactOption {
  id: string;
  business_id: string;
  name: string;
}

/**
 * One declared member pair in one direction: what the declaring company says
 * it is owed, against what the counterparty says it owes back.
 */
export interface IntercompanyPairRow {
  group_id: string;
  presentation_currency: string;
  relation: string;
  declaring_business_id: string;
  declaring_business_name: string;
  declaring_base_currency: string;
  declaring_closing_rate: number | null;
  counterparty_business_id: string;
  counterparty_business_name: string;
  counterparty_base_currency: string;
  counterparty_closing_rate: number | null;
  declaring_amount_base: number;
  declaring_amount: number;
  counterparty_amount_base: number;
  counterparty_amount: number;
  difference: number;
  declaring_contacts: number;
  counterparty_contacts: number;
}

/** Every declaration recorded for the group, including closed ones. */
export function useConsolidationIntercompanyPartners(groupId: string | null) {
  return useQuery({
    queryKey: ["consolidation-intercompany-partners", groupId],
    enabled: !!groupId,
    queryFn: async (): Promise<ConsolidationIntercompanyPartner[]> => {
      const { data, error } = await supabase
        .from("consolidation_intercompany_partners")
        .select(
          "id, organization_id, group_id, business_id, contact_id, counterparty_business_id, effective_from, effective_to, notes",
        )
        .eq("group_id", groupId!)
        .order("effective_from");
      if (error) throw error;
      return (data ?? []) as ConsolidationIntercompanyPartner[];
    },
  });
}

/** Contacts belonging to the member companies, for the declaration picker. */
export function useConsolidationMemberContacts(businessIds: string[]) {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;
  const key = [...businessIds].sort().join(",");

  return useQuery({
    queryKey: ["consolidation-member-contacts", orgId, key],
    enabled: !!orgId && businessIds.length > 0,
    queryFn: async (): Promise<MemberContactOption[]> => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, business_id, name")
        .eq("organization_id", orgId!)
        .in("business_id", businessIds)
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as MemberContactOption[];
    },
  });
}

/**
 * The paired intercompany positions for the period. The RPC refuses the run
 * when the group scope is not reportable or a member's closing rate is
 * missing — surface that message, never substitute a figure for it.
 */
export function useConsolidationIntercompanyBalances(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidation-intercompany-balances", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<IntercompanyPairRow[]> => {
      const { data, error } = await supabase.rpc("consolidation_intercompany_balances", {
        _group_id: groupId!,
        _date_from: dateFrom!,
        _date_to: dateTo!,
      });
      if (error) throw error;
      return (data ?? []) as IntercompanyPairRow[];
    },
  });
}

/** A pair only reconciles when both sides agree to the cent. */
export function isReconciled(row: IntercompanyPairRow): boolean {
  return Number(row.difference) === 0;
}

/**
 * Intercompany ledger activity at the grain the statements are read at:
 * member pair x group account. This is a projection of the translated
 * consolidated trial balance, so the account identity, its group-account
 * mapping and the rate applied are the same ones the statements use — an
 * intercompany figure here can never disagree with the line it belongs to.
 */
export interface IntercompanyActivityRow {
  group_id: string;
  presentation_currency: string;
  declaring_business_id: string;
  declaring_business_name: string;
  declaring_base_currency: string;
  counterparty_business_id: string;
  counterparty_business_name: string;
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  group_account_id: string | null;
  group_account_code: string | null;
  group_account_name: string | null;
  is_mapped: boolean;
  rate_class: string;
  rate_used: number;
  debit_base: number;
  credit_base: number;
  net_base: number;
  debit: number;
  credit: number;
  net: number;
  line_count: number;
  contact_count: number;
}

/**
 * Activity against a contact of a member company that carries NO declaration
 * for the period — the one blind spot a declaration-only model has. A
 * suggestion is offered only when a legal identifier matches another member
 * exactly; `suggestion_basis` says which. Amounts stay in the member's own
 * currency because this is a completeness worklist, not a reported figure.
 */
export interface IntercompanyCoverageRow {
  group_id: string;
  business_id: string;
  business_name: string;
  base_currency: string;
  contact_id: string;
  contact_name: string;
  contact_type: string;
  contact_tax_id: string | null;
  gl_line_count: number;
  gl_debit_base: number;
  gl_credit_base: number;
  gl_net_base: number;
  receivable_base: number;
  payable_base: number;
  first_activity: string | null;
  last_activity: string | null;
  suggested_counterparty_business_id: string | null;
  suggested_counterparty_business_name: string | null;
  suggestion_basis: string | null;
}

// The generated types file lags behind a just-deployed function; the argument
// and row shapes are asserted above and enforced by the RPC itself.
async function callConsolidationRpc<T>(
  fn: "consolidation_intercompany_activity" | "consolidation_intercompany_coverage",
  args: { _group_id: string; _date_from: string; _date_to: string },
): Promise<T[]> {
  const rpc = supabase.rpc as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

/**
 * Intercompany activity per group account. The RPC refuses the run for the same
 * reasons the consolidated statements do (unresolvable scope, missing rate,
 * unmapped posted account) — show its message rather than an empty table.
 */
export function useConsolidationIntercompanyActivity(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidation-intercompany-activity", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: () =>
      callConsolidationRpc<IntercompanyActivityRow>("consolidation_intercompany_activity", {
        _group_id: groupId!,
        _date_from: dateFrom!,
        _date_to: dateTo!,
      }),
  });
}

/** The undeclared-activity worklist. */
export function useConsolidationIntercompanyCoverage(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidation-intercompany-coverage", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: () =>
      callConsolidationRpc<IntercompanyCoverageRow>("consolidation_intercompany_coverage", {
        _group_id: groupId!,
        _date_from: dateFrom!,
        _date_to: dateTo!,
      }),
  });
}


export function useConsolidationIntercompanyMutations() {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["consolidation-intercompany-partners"] });
    queryClient.invalidateQueries({ queryKey: ["consolidation-intercompany-balances"] });
  };

  const declarePartner = useMutation({
    mutationFn: async (input: {
      group_id: string;
      business_id: string;
      contact_id: string;
      counterparty_business_id: string;
      effective_from?: string;
      notes?: string | null;
    }) => {
      if (!orgId) throw new Error("No active workspace");
      const { error } = await supabase
        .from("consolidation_intercompany_partners")
        .insert({ ...input, organization_id: orgId });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  /**
   * Ends a declaration with a date instead of deleting it, so a period already
   * reported keeps resolving the same way it was reported.
   */
  const closeDeclaration = useMutation({
    mutationFn: async ({ id, effectiveTo }: { id: string; effectiveTo: string }) => {
      const { error } = await supabase
        .from("consolidation_intercompany_partners")
        .update({ effective_to: effectiveTo })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  /** For a declaration entered in error and never reported on. */
  const deleteDeclaration = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("consolidation_intercompany_partners")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  return { declarePartner, closeDeclaration, deleteDeclaration };
}
