/**
 * Consolidation runs (Brick 8) — read and command layer only.
 *
 * NO ARITHMETIC LIVES HERE. A run is the *stored output* of the consolidation
 * engine: `consolidation_create_run` freezes the member scope as resolved, the
 * FX basis actually used and every statement line with its member
 * contributions and elimination effect. This module only lists runs, reads a
 * stored run back, and calls the three lifecycle RPCs
 * (`consolidation_create_run`, `consolidation_finalize_run`,
 * `consolidation_supersede_run`), each of which owns its own period control
 * and refusal rules. The client never recomputes a stored figure.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/supabaseError";
import type { Database } from "@/integrations/supabase/types";

export type ConsolidationRunState = "draft" | "final" | "superseded";

export const CONSOLIDATION_RUN_STATE_LABELS: Record<ConsolidationRunState, string> = {
  draft: "Draft",
  final: "Final",
  superseded: "Superseded",
};

export interface ConsolidationRun {
  id: string;
  organization_id: string;
  group_id: string;
  period_start: string;
  period_end: string;
  presentation_currency: string;
  state: ConsolidationRunState;
  eliminations_debit: number;
  eliminations_credit: number;
  balance_difference: number;
  is_balanced: boolean;
  line_count: number;
  member_count: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  finalized_by: string | null;
  finalized_at: string | null;
  superseded_at: string | null;
  superseded_by_run_id: string | null;
}

/** One member contribution frozen behind a stored line. */
export interface ConsolidationRunContribution {
  business_id: string;
  business_name: string;
  base_currency: string;
  rate_class: string | null;
  rate_used: number | null;
  closing_balance: number;
  translated_closing: number;
}

export interface ConsolidationRunLine {
  id: string;
  run_id: string;
  statement: string;
  section: string;
  section_order: number;
  group_account_id: string | null;
  account_code: string | null;
  account_name: string;
  account_type: Database["public"]["Enums"]["account_type"];
  is_residual: boolean;
  is_derived: boolean;
  presentation_currency: string;
  aggregated_amount: number;
  elimination_amount: number;
  consolidated_amount: number;
  member_contributions: ConsolidationRunContribution[];
  line_order: number;
}

export interface ConsolidationRunMember {
  id: string;
  run_id: string;
  business_id: string;
  business_name: string;
  base_currency: string;
  is_parent: boolean;
  method: "full" | "equity" | "proportionate" | "excluded";
  ownership_percent: number;
  requires_translation: boolean;
  effective_from: string | null;
  effective_to: string | null;
}

export interface ConsolidationRunRate {
  id: string;
  run_id: string;
  business_id: string;
  from_currency: string;
  to_currency: string;
  closing_rate: number | null;
  opening_rate: number | null;
  average_rate: number | null;
  prior_average_rate: number | null;
  historical_rate: number | null;
  historical_date: string | null;
}

/** Every run recorded for a group, newest first. */
export function useConsolidationRuns(groupId: string | null) {
  return useQuery({
    queryKey: ["consolidation-runs", groupId],
    enabled: !!groupId,
    queryFn: async (): Promise<ConsolidationRun[]> => {
      const { data, error } = await supabase
        .from("consolidation_runs")
        .select("*")
        .eq("group_id", groupId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw toAppError(error);
      return (data ?? []) as unknown as ConsolidationRun[];
    },
  });
}

/** The stored detail of one run: lines, member scope and FX basis. */
export function useConsolidationRunDetail(runId: string | null) {
  return useQuery({
    queryKey: ["consolidation-run-detail", runId],
    enabled: !!runId,
    queryFn: async () => {
      const [lines, members, rates] = await Promise.all([
        supabase
          .from("consolidation_run_lines")
          .select("*")
          .eq("run_id", runId!)
          .order("line_order", { ascending: true }),
        supabase
          .from("consolidation_run_members")
          .select("*")
          .eq("run_id", runId!)
          .order("is_parent", { ascending: false }),
        supabase.from("consolidation_run_rates").select("*").eq("run_id", runId!),
      ]);
      if (lines.error) throw toAppError(lines.error);
      if (members.error) throw toAppError(members.error);
      if (rates.error) throw toAppError(rates.error);
      return {
        lines: (lines.data ?? []) as unknown as ConsolidationRunLine[],
        members: (members.data ?? []) as unknown as ConsolidationRunMember[],
        rates: (rates.data ?? []) as unknown as ConsolidationRunRate[],
      };
    },
  });
}

function useInvalidateRuns() {
  const qc = useQueryClient();
  return (groupId?: string | null) => {
    qc.invalidateQueries({ queryKey: ["consolidation-runs", groupId ?? undefined] });
    qc.invalidateQueries({ queryKey: ["consolidation-runs"] });
    qc.invalidateQueries({ queryKey: ["consolidation-run-detail"] });
  };
}

export function useCreateConsolidationRun() {
  const invalidate = useInvalidateRuns();
  return useMutation({
    mutationFn: async (input: {
      groupId: string;
      dateFrom: string;
      dateTo: string;
      notes?: string | null;
    }): Promise<string> => {
      const { data, error } = await supabase.rpc("consolidation_create_run", {
        _group_id: input.groupId,
        _date_from: input.dateFrom,
        _date_to: input.dateTo,
        _notes: input.notes ?? null,
      });
      if (error) throw toAppError(error);
      return data as unknown as string;
    },
    onSuccess: (_id, vars) => invalidate(vars.groupId),
  });
}

export function useFinalizeConsolidationRun() {
  const invalidate = useInvalidateRuns();
  return useMutation({
    mutationFn: async (input: { runId: string; groupId: string }): Promise<string> => {
      const { data, error } = await supabase.rpc("consolidation_finalize_run", {
        _run_id: input.runId,
      });
      if (error) throw toAppError(error);
      return data as unknown as string;
    },
    onSuccess: (_id, vars) => invalidate(vars.groupId),
  });
}

export function useSupersedeConsolidationRun() {
  const invalidate = useInvalidateRuns();
  return useMutation({
    mutationFn: async (input: {
      runId: string;
      groupId: string;
      supersededByRunId?: string | null;
    }): Promise<string> => {
      const { data, error } = await supabase.rpc("consolidation_supersede_run", {
        _run_id: input.runId,
        _superseded_by_run_id: input.supersededByRunId ?? null,
      });
      if (error) throw toAppError(error);
      return data as unknown as string;
    },
    onSuccess: (_id, vars) => invalidate(vars.groupId),
  });
}
