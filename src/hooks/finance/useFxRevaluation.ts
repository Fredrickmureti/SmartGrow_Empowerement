import { normalizeError } from "@/services/resilience";
/**
 * useFxRevaluation — period-end unrealized FX gain/loss revaluation.
 *
 * Revaluation re-prices foreign-currency-denominated GL balances using the
 * latest exchange rate at the run date and posts the unrealized delta to
 * dedicated gain/loss accounts. Required for IFRS / GAAP compliance on
 * multi-currency books.
 *
 * Backed by `public.fx_revaluation_runs` and the `revalue_fx_balances` RPC.
 */
import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

export interface FxRevaluationRun {
  id: string;
  organization_id: string;
  business_id: string;
  run_date: string;
  base_currency: string;
  status: "draft" | "posted" | "reversed" | "failed";
  total_unrealized_gain: number;
  total_unrealized_loss: number;
  journal_entry_id: string | null;
  reversal_journal_entry_id?: string | null;
  fiscal_period_id?: string | null;
  reversed_at?: string | null;
  notes: string | null;
  created_at: string;
}

/**
 * Period-end readiness, straight from `public.fx_revaluation_readiness`.
 * The same function gates `close_fiscal_period` server-side, so the UI and the
 * database can never disagree about whether a period may be closed.
 */
export interface FxRevaluationReadiness {
  base_currency: string;
  as_of: string;
  fiscal_period_id: string | null;
  fiscal_period_name: string | null;
  fiscal_period_status: string | null;
  foreign_balances: Array<{
    currency: string;
    foreign_balance: number;
    account_count: number;
    rate: number | null;
  }>;
  missing_rates: string[];
  needs_revaluation: boolean;
  last_run_id: string | null;
  last_run_date: string | null;
}


export function useFxRevaluation() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const [runs, setRuns] = useState<FxRevaluationRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);

  const fetchRuns = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setRuns([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const { data, error } = await (supabase as any)
      .from("fx_revaluation_runs")
      .select("*")
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("run_date", { ascending: false })
      .limit(50);
    if (error) {
      console.error("Failed to load FX revaluation runs", error);
      setRuns([]);
    } else {
      setRuns((data ?? []) as FxRevaluationRun[]);
    }
    setIsLoading(false);
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  const runRevaluation = useCallback(
    async (params: {
      run_date: string;
      base_currency: string;
      unrealized_gain_account_id: string;
      unrealized_loss_account_id: string;
    }) => {
      if (!currentBusiness?.id) {
        throw new Error("Select a company first");
      }
      setIsRunning(true);
      try {
        const { data, error } = await (supabase as any).rpc(
          "revalue_fx_balances",
          {
            _business_id: currentBusiness.id,
            _run_date: params.run_date,
            _base_currency: params.base_currency,
            _unrealized_gain_account: params.unrealized_gain_account_id,
            _unrealized_loss_account: params.unrealized_loss_account_id,
            _user_id: user?.id ?? null,
          },
        );
        if (error) throw error;
        const result = (data ?? {}) as {
          lines?: number;
          unrealized_gain?: number;
          unrealized_loss?: number;
        };
        toast({
          title: "FX revaluation complete",
          description: `${result.lines ?? 0} accounts revalued. Gain: ${result.unrealized_gain ?? 0}, Loss: ${result.unrealized_loss ?? 0}.`,
        });
        await fetchRuns();
        return result;
      } catch (err: any) {
        toast({
          title: "FX revaluation failed",
          description: normalizeError(err).message,
          variant: "destructive",
        });
        throw err;
      } finally {
        setIsRunning(false);
      }
    },
    [currentBusiness?.id, user?.id, toast, fetchRuns],
  );

  return { runs, isLoading, isRunning, fetchRuns, runRevaluation };
}

/**
 * useFxRevaluationReadiness — foreign monetary balances still awaiting
 * revaluation as of a date, with the rate the resolver would use. Mirrors the
 * server-side gate on `close_fiscal_period` (ADR 0136).
 */
export function useFxRevaluationReadiness(asOf: string | null | undefined) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["fx-revaluation-readiness", currentBusiness?.id, asOf],
    enabled: !!currentBusiness?.id && !!asOf,
    staleTime: 30_000,
    queryFn: async (): Promise<FxRevaluationReadiness | null> => {
      const { data, error } = await (supabase as any).rpc(
        "fx_revaluation_readiness",
        { _business_id: currentBusiness!.id, _as_of: asOf },
      );
      if (error) throw error;
      return (data ?? null) as FxRevaluationReadiness | null;
    },
  });
}
