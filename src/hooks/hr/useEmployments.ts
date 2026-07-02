/**
 * useEmployments — CRUD for the employment-history table.
 *
 * Wave 2 introduced `public.employments` as the canonical source of truth
 * for hire/termination/transfer/rehire. The `employees` table now derives
 * `is_active`, `hire_date`, `termination_date`, `business_id`, and
 * `employment_type` from the most recent employment row via DB trigger
 * (`sync_employee_from_employments`).
 *
 * This hook is the only client-side writer. Direct writes to those
 * columns on `employees` are deprecated and will be removed in Wave 2C.
 */
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

export type EmploymentStatus = "active" | "on_leave" | "suspended" | "terminated";
export type EmploymentType = "full_time" | "part_time" | "contract" | "intern" | "consultant";
export type TerminationType =
  | "voluntary"
  | "involuntary"
  | "retirement"
  | "end_of_contract"
  | "death"
  | "other";

export interface Employment {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  employee_id: string;
  start_date: string;
  end_date: string | null;
  employment_type: EmploymentType;
  status: EmploymentStatus;
  termination_type: TerminationType | null;
  termination_reason: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export function useEmployments(employeeId: string | null | undefined) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();
  const orgId = currentOrg?.id ?? null;

  const query = useQuery({
    queryKey: ["employments", orgId, employeeId],
    enabled: !!orgId && !!employeeId,
    queryFn: async (): Promise<Employment[]> => {
      const { data, error } = await supabase
        .from("employments")
        .select("*")
        .eq("organization_id", orgId!)
        .eq("employee_id", employeeId!)
        .order("start_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Employment[];
    },
  });

  const employments = query.data ?? [];
  const currentEmployment = employments.find((e) => e.status !== "terminated") ?? employments[0] ?? null;

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["employments", orgId, employeeId] });
    qc.invalidateQueries({ queryKey: ["employees"] });
  }, [qc, orgId, employeeId]);

  /** Close the active employment spell — terminates the employee. */
  const terminate = useCallback(
    async (input: {
      end_date: string;
      termination_type: TerminationType;
      termination_reason?: string | null;
    }) => {
      if (!currentEmployment) {
        throw new Error("No active employment record to terminate.");
      }
      const { error } = await supabase
        .from("employments")
        .update({
          status: "terminated",
          end_date: input.end_date,
          termination_type: input.termination_type,
          termination_reason: input.termination_reason ?? null,
        })
        .eq("id", currentEmployment.id);
      if (error) throw error;
      invalidate();
    },
    [currentEmployment, invalidate],
  );

  /** Rehire — opens a new employment spell after a termination. */
  const rehire = useCallback(
    async (input: {
      business_id: string;
      branch_id?: string | null;
      start_date: string;
      employment_type?: EmploymentType;
    }) => {
      if (!orgId || !employeeId) throw new Error("Missing org or employee.");
      const { error } = await supabase.from("employments").insert({
        organization_id: orgId,
        business_id: input.business_id,
        branch_id: input.branch_id ?? null,
        employee_id: employeeId,
        start_date: input.start_date,
        employment_type: input.employment_type ?? "full_time",
        status: "active",
        is_primary: true,
      });
      if (error) throw error;
      invalidate();
    },
    [orgId, employeeId, invalidate],
  );

  return {
    employments,
    currentEmployment,
    isLoading: query.isLoading,
    error: query.error,
    terminate,
    rehire,
    refetch: query.refetch,
  };
}
