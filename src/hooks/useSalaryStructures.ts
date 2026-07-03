import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface SalaryStructure {
  id: string;
  organization_id: string;
  name: string;
  code: string | null;
  description: string | null;
  is_active: boolean;
  country_code: string | null;
  created_at: string;
  components?: SalaryComponent[];
}

export interface SalaryComponent {
  id: string;
  organization_id: string;
  structure_id: string;
  name: string;
  code: string;
  component_type: "earning" | "deduction" | "employer_contribution";
  computation_type: "fixed" | "percentage" | "formula";
  computation_value: number;
  percentage_of: string | null;
  is_taxable: boolean;
  is_statutory: boolean;
  statutory_rule_type: string | null;
  sort_order: number;
  is_active: boolean;
}

export function useSalaryStructures() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const { data: structures = [], isLoading } = useQuery({
    queryKey: ["salary-structures", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("salary_structures")
        .select("*, salary_components(*)")
        .eq("organization_id", currentOrg.id)
        .order("name");
      if (error) throw error;
      return (data || []).map((s: any) => ({
        ...s,
        components: (s.salary_components || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
      })) as SalaryStructure[];
    },
    enabled: !!currentOrg?.id,
  });

  const createStructure = useMutation({
    mutationFn: async (input: { name: string; code?: string; description?: string; country_code?: string; components: Record<string, any>[] }) => {
      if (!currentOrg?.id) throw new Error("No org");
      if (!currentBusiness?.id) throw new Error("No company selected — salary structures are per-company");
      const { data: structure, error } = await supabase
        .from("salary_structures")
        .insert({ organization_id: currentOrg.id, business_id: currentBusiness.id, name: input.name, code: input.code || null, description: input.description || null, country_code: input.country_code || null } as any)
        .select()
        .single();
      if (error) throw error;

      if (input.components.length > 0) {
        const { error: compErr } = await supabase
          .from("salary_components")
          .insert(input.components.map((c, i) => ({ ...c, organization_id: currentOrg.id, structure_id: structure.id, sort_order: c.sort_order ?? i })) as any);
        if (compErr) throw compErr;
      }
      return structure;
    },
    onSuccess: async (structure) => {
      // Optimistic insert so the list updates before the refetch resolves.
      // The row is added at the top of every cached key that prefix-matches
      // ["salary-structures", ...]. Invalidate + await so any active refetch
      // completes before the mutation promise settles — root-causes the
      // "list only updates after a page refresh" symptom reported in Phase 1.
      const inserted = { ...(structure as any), salary_components: [], components: [] } as SalaryStructure;
      queryClient.setQueriesData<SalaryStructure[]>({ queryKey: ["salary-structures"] }, (old) => {
        if (!Array.isArray(old)) return old as any;
        if (old.some((s) => s.id === inserted.id)) return old;
        return [inserted, ...old].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      });
      await queryClient.invalidateQueries({ queryKey: ["salary-structures"] });
      toast.success("Salary structure created");
    },
    onError: (err: any) => {
      // Surface actionable PG context (constraint name, hint, details) when present.
      const base = normalizeError(err).message || "Failed to create salary structure";
      const detail = err?.details || err?.hint;
      toast.error(detail ? `${base} — ${detail}` : base);
    },
  });

  const renameStructure = useMutation({
    mutationFn: async (input: {
      id: string;
      name: string;
      code?: string | null;
      description?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("rename_salary_structure" as any, {
        p_id: input.id,
        p_name: input.name,
        p_code: input.code ?? null,
        p_description: input.description ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["salary-structures"] });
      queryClient.invalidateQueries({ queryKey: ["payroll-salary-structures"] });
      toast.success("Salary structure updated");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  const archiveStructure = useMutation({
    mutationFn: async (input: { id: string; reason?: string }) => {
      const { data, error } = await supabase.rpc("archive_salary_structure" as any, {
        p_id: input.id,
        p_reason: input.reason ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["salary-structures"] });
      queryClient.invalidateQueries({ queryKey: ["payroll-salary-structures"] });
      toast.success("Salary structure archived");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  const restoreStructure = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc("restore_salary_structure" as any, {
        p_id: id,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["salary-structures"] });
      queryClient.invalidateQueries({ queryKey: ["payroll-salary-structures"] });
      toast.success("Salary structure restored");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  const deleteStructure = useMutation({
    mutationFn: async (input: { id: string; confirmName: string }) => {
      const { data, error } = await supabase.rpc("delete_salary_structure" as any, {
        p_id: input.id,
        p_confirm_name: input.confirmName,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["salary-structures"] });
      queryClient.invalidateQueries({ queryKey: ["payroll-salary-structures"] });
      toast.success("Salary structure deleted");
    },
    onError: (err: any) => {
      const base = normalizeError(err).message;
      const hint = err?.hint;
      toast.error(hint ? `${base} — ${hint}` : base);
    },
  });

  return {
    structures,
    isLoading,
    createStructure,
    renameStructure,
    archiveStructure,
    restoreStructure,
    deleteStructure,
  };
}

/**
 * Read-only preflight for hard-deleting a salary structure.
 * Returns the counts of blockers (contracts, payslips, in-flight runs)
 * and a computed `can_delete` flag. Only enabled when `structureId` is
 * provided — meant for use inside the delete-confirmation dialog.
 */
export function useSalaryStructureDeletionReport(structureId: string | null) {
  return useQuery({
    queryKey: ["salary-structure-deletion-report", structureId],
    enabled: !!structureId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "salary_structure_deletion_report" as any,
        { p_id: structureId! },
      );
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row as {
        structure_id: string;
        is_archived: boolean;
        contract_count: number;
        payslip_count: number;
        active_run_count: number;
        can_delete: boolean;
      } | null;
    },
  });
}

