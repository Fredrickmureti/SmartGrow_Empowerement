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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["salary-structures"] });
      toast.success("Salary structure created");
    },
    onError: (err: any) => {
      // Surface actionable PG context (constraint name, hint, details) when present.
      const base = normalizeError(err).message || "Failed to create salary structure";
      const detail = err?.details || err?.hint;
      toast.error(detail ? `${base} — ${detail}` : base);
    },
  });

  const deleteStructure = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("salary_structures").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["salary-structures"] });
      toast.success("Structure deleted");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  return { structures, isLoading, createStructure, deleteStructure };
}
