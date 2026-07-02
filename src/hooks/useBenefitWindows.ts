/**
 * useBenefitWindows — Turn F admin hook for `benefit_enrollment_windows`.
 *
 * Open-enrollment windows that gate `employee_benefits` mutations (via the
 * `block_locked_enrollment_window` trigger). RLS scopes to org HR.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

// Json-compatible value as stored in Supabase columns of type jsonb.
type JsonValue = string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[];

export interface BenefitWindow {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  plan_year: number;
  open_date: string;
  close_date: string;
  coverage_start: string;
  coverage_end: string;
  eligibility_filter: JsonValue;
  is_locked: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export function useBenefitWindows() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: windows = [], isLoading } = useQuery({
    queryKey: ["benefit-windows", currentOrg?.id, currentBusiness?.id ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("benefit_enrollment_windows")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("plan_year", { ascending: false })
        .order("open_date", { ascending: false });
      if (currentBusiness?.id) q = q.or(`business_id.eq.${currentBusiness.id},business_id.is.null`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as BenefitWindow[];
    },
    enabled: !!currentOrg?.id,
  });

  const createWindow = useMutation({
    mutationFn: async (
      input: Partial<BenefitWindow> & {
        name: string;
        plan_year: number;
        open_date: string;
        close_date: string;
        coverage_start: string;
        coverage_end: string;
      },
    ) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data, error } = await supabase
        .from("benefit_enrollment_windows")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id ?? null,
          eligibility_filter: {},
          is_locked: false,
          ...input,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["benefit-windows"] });
      toast.success("Enrollment window created");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateWindow = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<BenefitWindow> }) => {
      const { error } = await supabase
        .from("benefit_enrollment_windows")
        .update(patch as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["benefit-windows"] });
      toast.success("Enrollment window updated");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deleteWindow = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("benefit_enrollment_windows").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["benefit-windows"] });
      toast.success("Enrollment window removed");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { windows, isLoading, createWindow, updateWindow, deleteWindow };
}
