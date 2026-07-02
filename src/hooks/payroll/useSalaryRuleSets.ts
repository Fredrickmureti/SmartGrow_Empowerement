import { normalizeError } from "@/services/resilience";
/**
 * R3.1 — Hooks over the immutable salary_structure_rule_sets table.
 *
 * Read-only queries plus a publish mutation that wraps the SECURITY DEFINER
 * RPC `publish_salary_rule_set`. The RPC is idempotent on identical hash —
 * we detect that by comparing the returned id with the current active id.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface RuleSetRow {
  id: string;
  structure_id: string;
  version: number;
  rule_hash: string;
  status: string;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  components: any[];
  structure_name?: string;
  structure_code?: string | null;
}

export interface RuleSetForRun extends RuleSetRow {
  employee_count: number;
}

/** All rule sets actually stamped on a run's payslips, grouped by structure. */
export function useRuleSetsForRun(runId: string | undefined) {
  return useQuery({
    queryKey: ["payroll-run-rule-sets", runId],
    enabled: !!runId,
    queryFn: async (): Promise<RuleSetForRun[]> => {
      const { data: payslips, error } = await supabase
        .from("payslips")
        .select("rule_set_id")
        .eq("payroll_run_id", runId!)
        .not("rule_set_id", "is", null);
      if (error) throw error;
      const counts = new Map<string, number>();
      for (const p of (payslips ?? []) as any[]) {
        counts.set(p.rule_set_id, (counts.get(p.rule_set_id) ?? 0) + 1);
      }
      const ids = Array.from(counts.keys());
      if (ids.length === 0) return [];
      const { data: sets, error: e2 } = await supabase
        .from("salary_structure_rule_sets" as any)
        .select("id, structure_id, version, rule_hash, status, effective_from, effective_to, created_at, components")
        .in("id", ids);
      if (e2) throw e2;
      const structureIds = Array.from(new Set((sets ?? []).map((s: any) => s.structure_id)));
      const { data: structs } = await supabase
        .from("salary_structures")
        .select("id, name, code")
        .in("id", structureIds);
      const byStructure = new Map<string, any>((structs ?? []).map((s: any) => [s.id, s]));
      return (sets ?? []).map((s: any) => ({
        ...s,
        components: Array.isArray(s.components) ? s.components : [],
        employee_count: counts.get(s.id) ?? 0,
        structure_name: byStructure.get(s.structure_id)?.name,
        structure_code: byStructure.get(s.structure_id)?.code ?? null,
      }));
    },
  });
}

/** Full version history for a single salary structure. */
export function useRuleSetVersions(structureId: string | undefined) {
  return useQuery({
    queryKey: ["salary-rule-set-versions", structureId],
    enabled: !!structureId,
    queryFn: async (): Promise<RuleSetRow[]> => {
      const { data, error } = await supabase
        .from("salary_structure_rule_sets" as any)
        .select("id, structure_id, version, rule_hash, status, effective_from, effective_to, created_at, components")
        .eq("structure_id", structureId!)
        .order("version", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((s: any) => ({
        ...s,
        components: Array.isArray(s.components) ? s.components : [],
      }));
    },
  });
}

/** Publish a new rule set version. Idempotent on identical hash (RPC enforced). */
export function usePublishRuleSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ structureId, effectiveFrom }: { structureId: string; effectiveFrom?: string }) => {
      // Capture the current active id BEFORE publishing so we can detect idempotent no-op.
      const { data: beforeRaw } = await supabase
        .from("salary_structure_rule_sets" as any)
        .select("id, version")
        .eq("structure_id", structureId)
        .eq("status", "active")
        .maybeSingle();
      const before = beforeRaw as unknown as { id: string; version: number } | null;
      const { data: newId, error } = await supabase.rpc("publish_salary_rule_set", {
        p_structure_id: structureId,
        p_effective_from: effectiveFrom ?? new Date().toISOString().slice(0, 10),
      });
      if (error) throw error;
      // Resolve the version we ended up on.
      const { data: after } = await supabase
        .from("salary_structure_rule_sets" as any)
        .select("version")
        .eq("id", newId as string)
        .maybeSingle();
      const noChange = before?.id === newId;
      return { id: newId as string, version: (after as any)?.version as number, noChange };
    },
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: ["salary-rule-set-versions", vars.structureId] });
      qc.invalidateQueries({ queryKey: ["payroll-salary-structures"] });
      if (res.noChange) {
        toast.info(`No changes — v${res.version} is already current`);
      } else {
        toast.success(`Published v${res.version}`);
      }
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Failed to publish rule set"),
  });
}
