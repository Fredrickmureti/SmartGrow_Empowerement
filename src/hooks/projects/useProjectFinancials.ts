/**
 * useProjectFinancials — real project profitability sourced from
 * the analytic ledger tables (project_cost_entries / project_revenue_entries)
 * via the compute_project_profitability RPC.
 *
 * Every number returned here traces back to a real source row
 * (timesheet, expense, vendor bill, invoice, milestone). No estimates.
 */
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ProjectFinancials {
  project_id: string;
  currency: string;
  cost_total: number;
  revenue_total: number;
  committed_cost_total: number;
  committed_revenue_total: number;
  margin: number;
  margin_pct: number | null;
  has_unconverted_entries: boolean;
  unconverted_cost_count: number;
  unconverted_revenue_count: number;
  planned_hours: number;
  logged_hours: number;
  budget: number | null;
  budget_used_pct: number | null;
  cost_by_source: Record<string, number>;
  revenue_by_source: Record<string, number>;
}

export interface ProjectLedgerEntry {
  id: string;
  source_type: string;
  source_id: string | null;
  amount: number;
  amount_base: number | null;
  currency: string;
  base_currency: string | null;
  entry_nature: "actual" | "commitment";
  posted_at: string;
  description: string | null;
  hours?: number | null;
  employee_id?: string | null;
  task_id?: string | null;
  milestone_id?: string | null;
}

export function useProjectFinancials(projectId: string | undefined) {
  const [data, setData] = useState<ProjectFinancials | null>(null);
  const [costs, setCosts] = useState<ProjectLedgerEntry[]>([]);
  const [revenues, setRevenues] = useState<ProjectLedgerEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    setError(null);
    try {
      const [{ data: rpc, error: rpcErr }, { data: cs }, { data: rs }] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.rpc as any)("compute_project_profitability", { _project_id: projectId }),
        supabase
          .from("project_cost_entries")
          .select("id, source_type, source_id, amount, amount_base, currency, base_currency, entry_nature, posted_at, description, hours, employee_id, task_id")
          .eq("project_id", projectId)
          .order("posted_at", { ascending: false })
          .limit(500),
        supabase
          .from("project_revenue_entries")
          .select("id, source_type, source_id, amount, amount_base, currency, base_currency, entry_nature, posted_at, description, milestone_id")
          .eq("project_id", projectId)
          .order("posted_at", { ascending: false })
          .limit(500),
      ]);
      if (rpcErr) throw rpcErr;
      setData(rpc as ProjectFinancials);
      setCosts((cs ?? []) as unknown as ProjectLedgerEntry[]);
      setRevenues((rs ?? []) as unknown as ProjectLedgerEntry[]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, costs, revenues, isLoading, error, refresh };
}
