/**
 * useHRPolicies — single-row-per-business HR defaults
 * (probation, notice, leave year start, employee number format,
 * default onboarding/offboarding templates).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface HRPolicies {
  id: string;
  organization_id: string;
  business_id: string;
  probation_period_months: number;
  notice_period_days: number;
  leave_year_start_month: number;
  employee_number_format: string;
  employee_number_next_seq: number;
  default_onboarding_template_id: string | null;
  default_offboarding_template_id: string | null;
  retire_age: number | null;
}

export function useHRPolicies() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["hr-policies", currentBusiness?.id],
    queryFn: async (): Promise<HRPolicies | null> => {
      if (!currentBusiness?.id) return null;
      const { data, error } = await supabase
        .from("hr_policies")
        .select("*")
        .eq("business_id", currentBusiness.id)
        .maybeSingle();
      if (error) throw error;
      return (data as any) ?? null;
    },
    enabled: !!currentBusiness?.id,
  });

  const save = useMutation({
    mutationFn: async (patch: Partial<HRPolicies>) => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("Select a business first");
      const payload: any = {
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        ...patch,
      };
      const { error } = await supabase
        .from("hr_policies")
        .upsert(payload, { onConflict: "business_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hr-policies"] });
      toast.success("HR policies saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { policies: data, isLoading, save };
}
