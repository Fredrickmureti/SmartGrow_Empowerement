/**
 * Intercompany eliminations (Brick 7) — read and command layer only.
 *
 * NO ARITHMETIC LIVES HERE. Every elimination amount, every difference and
 * every consolidated figure is produced by the database:
 *
 * - `consolidation_generate_eliminations(group, from, to)` builds the
 *   elimination set for a period from `consolidation_intercompany_flows`,
 *   which is itself a projection of the translated consolidated trial balance.
 *   It refuses the run when the two sides of a declared pair disagree beyond
 *   the group's configured tolerance, unless a difference account is named.
 * - `consolidation_eliminations` is engine output: a database trigger refuses
 *   hand-written rows, so this module never inserts into it.
 * - `get_consolidated_statement_lines_eliminated` /
 *   `get_consolidated_statement_totals_eliminated` present the aggregated,
 *   elimination and consolidated columns side by side.
 *
 * The only writes here are the *policy* rows in
 * `consolidation_elimination_rules` — tolerance, difference policy and the
 * difference account — which are decisions a person makes, not figures.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/supabaseError";
import { useOrganization } from "@/hooks/useOrganization";
import type { Database } from "@/integrations/supabase/types";

export type EliminationClass =
  Database["public"]["Enums"]["consolidation_elimination_class"];
export type EliminationDifferencePolicy =
  Database["public"]["Enums"]["consolidation_elimination_difference_policy"];

export const ELIMINATION_CLASS_LABELS: Record<string, string> = {
  intercompany_balance: "Intercompany balances",
  intercompany_trading: "Intercompany trading",
};

export const ELIMINATION_POLICY_LABELS: Record<string, string> = {
  refuse: "Refuse the run",
  post_difference: "Post the difference to an account",
  post_to_cta: "Carry the difference to the translation reserve",
};

/** One generated elimination leg, as stored by the engine. */
export interface EliminationRow {
  id: string;
  group_id: string;
  period_start: string;
  period_end: string;
  elimination_class: EliminationClass;
  declaring_business_id: string;
  counterparty_business_id: string;
  group_account_id: string;
  group_account_code: string;
  group_account_name: string;
  account_type: string;
  presentation_currency: string;
  debit: number;
  credit: number;
  is_difference: boolean;
  source_evidence: unknown;
  generated_at: string;
  /** Resolved for display only — never used in a calculation. */
  declaring_business_name: string;
  counterparty_business_name: string;
}

export interface EliminationRule {
  id: string;
  group_id: string;
  elimination_class: EliminationClass;
  is_active: boolean;
  tolerance_amount: number;
  difference_policy: EliminationDifferencePolicy;
  difference_group_account_id: string | null;
  notes: string | null;
}

export interface EliminationGenerationSummary {
  elimination_class: EliminationClass;
  pair_count: number;
  line_count: number;
  eliminated_debit: number;
  eliminated_credit: number;
  difference_amount: number;
}

export interface IntercompanyFlowRow {
  declaring_business_id: string;
  declaring_business_name: string;
  counterparty_business_id: string;
  counterparty_business_name: string;
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  group_account_id: string;
  group_account_code: string;
  group_account_name: string;
  basis: string;
  rate_class: string;
  rate_used: number;
  debit_base: number;
  credit_base: number;
  debit_presentation: number;
  credit_presentation: number;
  entry_count: number;
  presentation_currency: string;
}

export interface EliminatedStatementLine {
  statement: string;
  section: string;
  section_order: number;
  account_id: string | null;
  account_code: string | null;
  account_name: string;
  account_type: string;
  is_residual: boolean;
  is_derived: boolean;
  presentation_currency: string;
  aggregated_amount: number;
  elimination_amount: number;
  consolidated_amount: number;
}

export interface EliminatedStatementTotals {
  presentation_currency: string;
  total_income: number;
  total_expense: number;
  net_result: number;
  total_assets: number;
  total_liabilities: number;
  total_equity: number;
  eliminations_debit: number;
  eliminations_credit: number;
  balance_sheet_difference: number;
  is_balanced: boolean;
}

/**
 * The stored elimination set for a group and period, with member names
 * resolved for display. Empty means "not generated yet" — it never means
 * "nothing to eliminate"; the page says which.
 */
export function useConsolidationEliminations(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidation-eliminations", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<EliminationRow[]> => {
      const { data, error } = await supabase
        .from("consolidation_eliminations")
        .select("*")
        .eq("group_id", groupId!)
        .eq("period_start", dateFrom!)
        .eq("period_end", dateTo!)
        .order("elimination_class", { ascending: true })
        .order("group_account_code", { ascending: true });
      if (error) throw toAppError(error);

      const rows = data ?? [];
      const ids = Array.from(
        new Set(
          rows.flatMap((r) => [r.declaring_business_id, r.counterparty_business_id]),
        ),
      );
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const { data: businesses, error: bizError } = await supabase
          .from("businesses")
          .select("id, name")
          .in("id", ids);
        if (bizError) throw bizError;
        for (const b of businesses ?? []) names.set(b.id, b.name);
      }

      return rows.map((r) => ({
        ...r,
        declaring_business_name: names.get(r.declaring_business_id) ?? "Unknown company",
        counterparty_business_name:
          names.get(r.counterparty_business_id) ?? "Unknown company",
      })) as EliminationRow[];
    },
  });
}

/** The per-class elimination policy for a group. */
export function useConsolidationEliminationRules(groupId: string | null) {
  return useQuery({
    queryKey: ["consolidation-elimination-rules", groupId],
    enabled: !!groupId,
    queryFn: async (): Promise<EliminationRule[]> => {
      const { data, error } = await supabase
        .from("consolidation_elimination_rules")
        .select("*")
        .eq("group_id", groupId!);
      if (error) throw toAppError(error);
      return (data ?? []) as EliminationRule[];
    },
  });
}

/**
 * The intercompany positions the engine consumed, for drill-down beneath an
 * elimination leg. Same RPC the generator itself reads.
 */
export function useConsolidationIntercompanyFlows(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidation-intercompany-flows", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<IntercompanyFlowRow[]> => {
      const { data, error } = await supabase.rpc("consolidation_intercompany_flows", {
        _group_id: groupId!,
        _date_from: dateFrom!,
        _date_to: dateTo!,
      });
      if (error) throw toAppError(error);
      return (data ?? []) as unknown as IntercompanyFlowRow[];
    },
  });
}

/** Statement lines with the aggregated / eliminations / consolidated columns. */
export function useEliminatedStatementLines(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidated-statement-lines-eliminated", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<EliminatedStatementLine[]> => {
      const { data, error } = await supabase.rpc(
        "get_consolidated_statement_lines_eliminated",
        { _group_id: groupId!, _date_from: dateFrom!, _date_to: dateTo! },
      );
      if (error) throw toAppError(error);
      return (data ?? []) as unknown as EliminatedStatementLine[];
    },
  });
}

/** Post-elimination totals, including the server's own balance verdict. */
export function useEliminatedStatementTotals(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidated-statement-totals-eliminated", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<EliminatedStatementTotals | null> => {
      const { data, error } = await supabase.rpc(
        "get_consolidated_statement_totals_eliminated",
        { _group_id: groupId!, _date_from: dateFrom!, _date_to: dateTo! },
      );
      if (error) throw toAppError(error);
      const rows = (data ?? []) as unknown as EliminatedStatementTotals[];
      return rows[0] ?? null;
    },
  });
}

export function useConsolidationEliminationMutations() {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["consolidation-eliminations"] });
    queryClient.invalidateQueries({ queryKey: ["consolidation-elimination-rules"] });
    queryClient.invalidateQueries({
      queryKey: ["consolidated-statement-lines-eliminated"],
    });
    queryClient.invalidateQueries({
      queryKey: ["consolidated-statement-totals-eliminated"],
    });
  };

  /**
   * Ask the engine to build the period's eliminations. Its refusals — an
   * uncovered rate, a member the caller cannot see, an unmapped account, two
   * sides that disagree — come back as errors and must be shown verbatim.
   */
  const generate = useMutation({
    mutationFn: async (input: {
      group_id: string;
      date_from: string;
      date_to: string;
    }): Promise<EliminationGenerationSummary[]> => {
      const { data, error } = await supabase.rpc("consolidation_generate_eliminations", {
        _group_id: input.group_id,
        _date_from: input.date_from,
        _date_to: input.date_to,
      });
      if (error) throw toAppError(error);
      return (data ?? []) as unknown as EliminationGenerationSummary[];
    },
    onSuccess: invalidate,
  });

  const saveRule = useMutation({
    mutationFn: async (input: {
      group_id: string;
      elimination_class: EliminationClass;
      is_active: boolean;
      tolerance_amount: number;
      difference_policy: EliminationDifferencePolicy;
      difference_group_account_id: string | null;
      notes?: string | null;
    }) => {
      if (!orgId) throw new Error("No active workspace");
      const { error } = await supabase
        .from("consolidation_elimination_rules")
        .upsert(
          { ...input, organization_id: orgId },
          { onConflict: "group_id,elimination_class" },
        );
      if (error) throw toAppError(error);
    },
    onSuccess: invalidate,
  });

  return { generate, saveRule };
}
