/**
 * useHRAnalytics — Turn G read hooks over the four pre-existing analytics views:
 *   - v_hr_headcount_snapshot         (department × type counts, today)
 *   - v_hr_turnover_rolling_12m       (per-department turnover %)
 *   - v_payroll_cost_by_department    (per-run, per-department gross/net)
 *   - v_leave_liability_open          (per-employee × leave-type open liability)
 *
 * All views are scoped by RLS to org members; we still filter by org_id +
 * (when set) business_id to keep the workspace's branch lens honest.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useQuery } from "@tanstack/react-query";

export interface HeadcountRow {
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  department_id: string | null;
  department_name: string | null;
  total_count: number;
  active_count: number;
  inactive_count: number;
  full_time_count: number;
  part_time_count: number;
  contract_count: number;
  snapshot_date: string;
}

export interface TurnoverRow {
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  department_id: string | null;
  active_now: number;
  total_now: number;
  hires_12m: number;
  terminations_12m: number;
  turnover_pct: number;
}

export interface PayrollCostRow {
  organization_id: string;
  business_id: string | null;
  payroll_run_id: string;
  payroll_number: string | null;
  pay_period_start: string;
  pay_period_end: string;
  run_status: string;
  currency: string | null;
  department_id: string | null;
  department_name: string | null;
  employee_count: number;
  total_gross: number;
  total_deductions: number;
  total_net: number;
}

export interface LeaveLiabilityRow {
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  department_id: string | null;
  leave_type_id: string;
  leave_type_name: string | null;
  is_paid: boolean;
  year: number;
  days_allocated: number;
  days_used: number;
  days_pending: number;
  days_open: number;
  liability_amount: number;
}

function orgScope<T>(q: any, orgId?: string, bizId?: string | null) {
  if (!orgId) return q;
  q = q.eq("organization_id", orgId);
  if (bizId) q = q.or(`business_id.eq.${bizId},business_id.is.null`);
  return q as T;
}

export function useHeadcountSnapshot() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["v-hr-headcount-snapshot", currentOrg?.id, currentBusiness?.id ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [] as HeadcountRow[];
      const { data, error } = await orgScope<any>(
        supabase.from("v_hr_headcount_snapshot").select("*"),
        currentOrg.id,
        currentBusiness?.id ?? null,
      );
      if (error) throw error;
      return (data ?? []) as HeadcountRow[];
    },
    enabled: !!currentOrg?.id,
  });
}

export function useTurnover12m() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["v-hr-turnover-12m", currentOrg?.id, currentBusiness?.id ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [] as TurnoverRow[];
      const { data, error } = await orgScope<any>(
        supabase.from("v_hr_turnover_rolling_12m").select("*"),
        currentOrg.id,
        currentBusiness?.id ?? null,
      );
      if (error) throw error;
      return (data ?? []) as TurnoverRow[];
    },
    enabled: !!currentOrg?.id,
  });
}

export function usePayrollCostByDepartment(limit = 200) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["v-payroll-cost-by-dept", currentOrg?.id, currentBusiness?.id ?? null, limit],
    queryFn: async () => {
      if (!currentOrg?.id) return [] as PayrollCostRow[];
      const { data, error } = await orgScope<any>(
        supabase
          .from("v_payroll_cost_by_department")
          .select("*")
          .order("pay_period_end", { ascending: false })
          .limit(limit),
        currentOrg.id,
        currentBusiness?.id ?? null,
      );
      if (error) throw error;
      return (data ?? []) as PayrollCostRow[];
    },
    enabled: !!currentOrg?.id,
  });
}

export function useLeaveLiabilityOpen() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["v-leave-liability-open", currentOrg?.id, currentBusiness?.id ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [] as LeaveLiabilityRow[];
      const { data, error } = await orgScope<any>(
        supabase.from("v_leave_liability_open").select("*"),
        currentOrg.id,
        currentBusiness?.id ?? null,
      );
      if (error) throw error;
      return (data ?? []) as LeaveLiabilityRow[];
    },
    enabled: !!currentOrg?.id,
  });
}
