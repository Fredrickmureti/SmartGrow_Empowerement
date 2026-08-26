/**
 * useTimesheetMetrics — Wave 4 canonical metrics.
 *
 * Every reported timesheet number (total / approved / billable / non-billable /
 * overtime / payroll-locked / uninvoiced billable / utilisation) comes from the
 * database functions created in Wave 4:
 *   get_timesheet_employee_metrics, get_timesheet_project_metrics,
 *   get_timesheet_summary, get_timesheet_uninvoiced_billable
 *
 * There is NO metric arithmetic in the browser: overtime thresholds and the
 * week-start rule live in timesheet_settings and are applied server-side, and
 * superseded (corrected) entries are excluded by v_timesheet_entry_canonical.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface TimesheetEmployeeMetrics {
  employee_id: string;
  employee_name: string;
  employee_number: string | null;
  total_hours: number;
  approved_hours: number;
  billable_hours: number;
  non_billable_hours: number;
  overtime_hours: number;
  payroll_locked_hours: number;
  uninvoiced_billable_hours: number;
  utilization_pct: number;
}

export interface TimesheetProjectMetrics {
  project_id: string | null;
  project_name: string;
  project_number: string | null;
  customer_id: string | null;
  project_is_billable: boolean | null;
  total_hours: number;
  approved_hours: number;
  billable_hours: number;
  non_billable_hours: number;
  invoiced_hours: number;
  uninvoiced_billable_hours: number;
  utilization_pct: number;
}

export interface TimesheetSummaryMetrics {
  total_hours: number;
  approved_hours: number;
  billable_hours: number;
  non_billable_hours: number;
  overtime_hours: number;
  payroll_locked_hours: number;
  uninvoiced_billable_hours: number;
  utilization_pct: number;
  employee_count: number;
}

export interface TimesheetUninvoicedRow {
  timesheet_id: string;
  date: string;
  employee_id: string;
  employee_name: string;
  project_id: string | null;
  project_name: string;
  hours: number;
  billing_amount: number | null;
}

const EMPTY_SUMMARY: TimesheetSummaryMetrics = {
  total_hours: 0,
  approved_hours: 0,
  billable_hours: 0,
  non_billable_hours: 0,
  overtime_hours: 0,
  payroll_locked_hours: 0,
  uninvoiced_billable_hours: 0,
  utilization_pct: 0,
  employee_count: 0,
};

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * Canonical timesheet metrics for a date range in the current org/business scope.
 */
export function useTimesheetMetrics(from: string, to: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  // p_business_id is nullable server-side (null = all businesses in the org);
  // the generated Args type models it as non-null, hence the single narrow cast.
  const rpcArgs = {
    p_organization_id: currentOrg?.id ?? "",
    p_business_id: (currentBusiness?.id ?? null) as unknown as string,
    p_from: from,
    p_to: to,
  };
  const enabled = !!currentOrg?.id && !!from && !!to;
  const scope = [currentOrg?.id, currentBusiness?.id ?? null, from, to];

  const employees = useQuery<TimesheetEmployeeMetrics[]>({
    queryKey: ["timesheet-metrics", "employee", ...scope],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_timesheet_employee_metrics", rpcArgs);
      if (error) throw error;
      return (data ?? []).map((r) => ({
        employee_id: r.employee_id,
        employee_name: r.employee_name || "Unknown",
        employee_number: r.employee_number ?? null,
        total_hours: num(r.total_hours),
        approved_hours: num(r.approved_hours),
        billable_hours: num(r.billable_hours),
        non_billable_hours: num(r.non_billable_hours),
        overtime_hours: num(r.overtime_hours),
        payroll_locked_hours: num(r.payroll_locked_hours),
        uninvoiced_billable_hours: num(r.uninvoiced_billable_hours),
        utilization_pct: num(r.utilization_pct),
      }));
    },
  });

  const projects = useQuery<TimesheetProjectMetrics[]>({
    queryKey: ["timesheet-metrics", "project", ...scope],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_timesheet_project_metrics", rpcArgs);
      if (error) throw error;
      return (data ?? []).map((r) => ({
        project_id: r.project_id ?? null,
        project_name: r.project_name || "No project",
        project_number: r.project_number ?? null,
        customer_id: r.customer_id ?? null,
        project_is_billable: r.project_is_billable ?? null,
        total_hours: num(r.total_hours),
        approved_hours: num(r.approved_hours),
        billable_hours: num(r.billable_hours),
        non_billable_hours: num(r.non_billable_hours),
        invoiced_hours: num(r.invoiced_hours),
        uninvoiced_billable_hours: num(r.uninvoiced_billable_hours),
        utilization_pct: num(r.utilization_pct),
      }));
    },
  });

  const summary = useQuery<TimesheetSummaryMetrics>({
    queryKey: ["timesheet-metrics", "summary", ...scope],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_timesheet_summary", rpcArgs);
      if (error) throw error;
      const r = (data ?? [])[0];
      if (!r) return EMPTY_SUMMARY;
      return {
        total_hours: num(r.total_hours),
        approved_hours: num(r.approved_hours),
        billable_hours: num(r.billable_hours),
        non_billable_hours: num(r.non_billable_hours),
        overtime_hours: num(r.overtime_hours),
        payroll_locked_hours: num(r.payroll_locked_hours),
        uninvoiced_billable_hours: num(r.uninvoiced_billable_hours),
        utilization_pct: num(r.utilization_pct),
        employee_count: num(r.employee_count),
      };
    },
  });

  const uninvoiced = useQuery<TimesheetUninvoicedRow[]>({
    queryKey: ["timesheet-metrics", "uninvoiced", ...scope],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_timesheet_uninvoiced_billable", rpcArgs);
      if (error) throw error;
      return (data ?? []).map((r) => ({
        timesheet_id: r.timesheet_id,
        date: r.date,
        employee_id: r.employee_id,
        employee_name: r.employee_name || "—",
        project_id: r.project_id ?? null,
        project_name: r.project_name || "No project",
        hours: num(r.hours),
        billing_amount: r.billing_amount == null ? null : Number(r.billing_amount),
      }));
    },
  });

  return {
    byEmployee: employees.data ?? [],
    byProject: projects.data ?? [],
    summary: summary.data ?? EMPTY_SUMMARY,
    uninvoiced: uninvoiced.data ?? [],
    isLoading:
      employees.isLoading || projects.isLoading || summary.isLoading || uninvoiced.isLoading,
    error:
      employees.error ?? projects.error ?? summary.error ?? uninvoiced.error ?? null,
    refresh: () => {
      employees.refetch();
      projects.refetch();
      summary.refetch();
      uninvoiced.refetch();
    },
  };
}
