import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface BenefitPlan {
  id: string;
  organization_id: string;
  name: string;
  benefit_type: string;
  description: string | null;
  provider: string | null;
  employer_contribution: number;
  employee_contribution: number;
  contribution_type: string;
  is_active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  created_at: string;
}

export interface EmployeeBenefit {
  id: string;
  organization_id: string;
  employee_id: string;
  benefit_plan_id: string;
  enrollment_date: string;
  end_date: string | null;
  status: string;
  notes: string | null;
  benefit_plan?: BenefitPlan;
}

export function useBenefitPlans() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ["benefit-plans", currentOrg?.id, currentBusiness?.id ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      // Defect fix (audit C6): scope by business_id only when one is selected.
      // Org-wide users (no active business) used to crash on currentBusiness.id.
      let q = supabase
        .from("benefit_plans")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("name");
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      const { data, error } = await q;
      if (error) throw error;
      return data as BenefitPlan[];
    },
    enabled: !!currentOrg?.id,
  });

  const createPlan = useMutation({
    mutationFn: async (input: Omit<BenefitPlan, "id" | "organization_id" | "created_at">) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data, error } = await supabase
        .from("benefit_plans")
        .insert({ ...input, organization_id: currentOrg.id })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["benefit-plans"] });
      toast.success("Benefit plan created");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  const deletePlan = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("benefit_plans").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["benefit-plans"] });
      toast.success("Plan deleted");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  return { plans, isLoading, createPlan, deletePlan };
}

export function useEmployeeBenefits(employeeId: string | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const { data: benefits = [], isLoading } = useQuery({
    queryKey: ["employee-benefits", employeeId, currentOrg?.id],
    queryFn: async () => {
      if (!employeeId || !currentOrg?.id) return [];
      let q = supabase
        // SCOPE-EXEMPT: filtered by employee_id (PK) which is itself business-scoped
        .from("employee_benefits")
        .select("*, benefit_plans(*)")
        .eq("employee_id", employeeId)
        .eq("organization_id", currentOrg.id)
        .order("enrollment_date", { ascending: false });
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map((b: any) => ({ ...b, benefit_plan: b.benefit_plans })) as EmployeeBenefit[];
    },

    enabled: !!employeeId && !!currentOrg?.id,
  });

  const enrollBenefit = useMutation({
    mutationFn: async (input: { benefit_plan_id: string; enrollment_date?: string; notes?: string }) => {
      if (!employeeId || !currentOrg?.id) throw new Error("Missing context");
      // Look up the employee's business so the benefit row inherits its scope.
      const { data: emp, error: empErr } = await supabase
        .from("v_employees_canonical").select("business_id").eq("id", employeeId).maybeSingle();
      if (empErr) throw empErr;
      if (!emp?.business_id) throw new Error("Employee is not assigned to a company");
      const { data, error } = await supabase
        .from("employee_benefits")
        .insert({ organization_id: currentOrg.id, business_id: emp.business_id, employee_id: employeeId, ...input } as any)
        .select("*, benefit_plans(*)")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["employee-benefits", employeeId] });
      toast.success("Employee enrolled in benefit plan");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  const terminateBenefit = useMutation({
    mutationFn: async (benefitId: string) => {
      const { error } = await supabase
        .from("employee_benefits")
        .update({ status: "terminated", end_date: new Date().toISOString().split("T")[0] })
        .eq("id", benefitId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["employee-benefits", employeeId] });
      toast.success("Benefit terminated");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  return { benefits, isLoading, enrollBenefit, terminateBenefit };
}
