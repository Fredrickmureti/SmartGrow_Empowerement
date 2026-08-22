/**
 * Revision history for an activated budget.
 *
 * Post-activation change is never an in-place edit: `apply_budget_revision`
 * records a numbered revision plus a per-line before/after trail. This hook
 * reads that trail for display. Row visibility is enforced by RLS on
 * `budget_revisions` / `budget_revision_lines`.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface BudgetRevisionLine {
  id: string;
  account_id: string;
  period_month: number;
  fiscal_period_id: string | null;
  previous_amount: number | null;
  new_amount: number | null;
  accounts?: { code: string; name: string } | null;
}

export interface BudgetRevision {
  id: string;
  budget_id: string;
  revision_number: number;
  reason: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  lines: BudgetRevisionLine[];
}

export function useBudgetRevisions(budgetId?: string) {
  const { data: revisions = [], isLoading } = useQuery({
    queryKey: ["budget-revisions", budgetId],
    queryFn: async (): Promise<BudgetRevision[]> => {
      if (!budgetId) return [];
      const { data, error } = await supabase
        // SCOPE-EXEMPT: budget_revisions rows are reachable only through their
        // parent budget, whose RLS policy already enforces business + branch +
        // financials-read access.
        .from("budget_revisions")
        .select(
          `id, budget_id, revision_number, reason, note, created_by, created_at,
           budget_revision_lines(
             id, account_id, period_month, fiscal_period_id, previous_amount, new_amount,
             accounts(code, name)
           )`,
        )
        .eq("budget_id", budgetId)
        .order("revision_number", { ascending: false });
      if (error) throw error;

      return (data ?? []).map((r) => {
        const row = r as typeof r & { budget_revision_lines?: BudgetRevisionLine[] };
        return {
          id: row.id,
          budget_id: row.budget_id,
          revision_number: row.revision_number,
          reason: row.reason,
          note: row.note,
          created_by: row.created_by,
          created_at: row.created_at,
          lines: (row.budget_revision_lines ?? []).slice().sort(
            (a, b) => a.period_month - b.period_month,
          ),
        };
      });
    },
    enabled: !!budgetId,
  });

  return { revisions, isLoading };
}
