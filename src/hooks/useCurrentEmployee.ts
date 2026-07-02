import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * useCurrentEmployee — single client-side entry point for "who am I as an
 * employee in this workspace".
 *
 * Source of truth is the server RPC `resolve_my_employee()`. The resolver
 * looks at `employees.user_id = auth.uid()` FIRST and returns that
 * employee's org/business as the authoritative scope. The hook deliberately
 * does NOT depend on `useOrganization` / `useBusinesses` — those derive
 * from `user_roles` and can lag or disagree with the actual employee
 * linkage, which was the root cause of the "linked yet not linked"
 * contradiction in the portal.
 */
export interface CurrentEmployee {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  email: string;
  department_id: string | null;
  manager_id: string | null;
  user_id: string | null;
  organization_id: string;
  business_id: string | null;
  avatar_url: string | null;
}

export interface DirectReport {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  email: string;
  department_id: string | null;
}

export function useCurrentEmployee() {
  const { user } = useAuth();
  const [currentEmployee, setCurrentEmployee] = useState<CurrentEmployee | null>(null);
  const [employeeOrgId, setEmployeeOrgId] = useState<string | null>(null);
  const [employeeBusinessId, setEmployeeBusinessId] = useState<string | null>(null);
  const [directReports, setDirectReports] = useState<DirectReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isManager, setIsManager] = useState(false);
  // True ONLY for org owner/admin/super_admin in a brand-new org with no
  // employee records yet. Comes from the server resolver, never the client.
  const [canSelfLink, setCanSelfLink] = useState(false);

  const fetchCurrentEmployee = useCallback(async () => {
    if (!user) {
      setCurrentEmployee(null);
      setEmployeeOrgId(null);
      setEmployeeBusinessId(null);
      setDirectReports([]);
      setIsManager(false);
      setCanSelfLink(false);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      // Server resolver = single source of truth. We do NOT gate on
      // useOrganization / useBusinesses; the resolver tells us which org
      // and business the user is an employee in.
      const { data: resolverRows, error: resolverErr } = await supabase
        .rpc("resolve_my_employee" as any);

      if (resolverErr) throw resolverErr;
      const resolved = Array.isArray(resolverRows) ? resolverRows[0] : resolverRows;
      const isLinked: boolean = !!resolved?.is_linked;
      setCanSelfLink(!!resolved?.can_self_link);
      setEmployeeOrgId(resolved?.organization_id ?? null);
      setEmployeeBusinessId(resolved?.business_id ?? null);

      if (!isLinked || !resolved?.employee_id) {
        setCurrentEmployee(null);
        setDirectReports([]);
        setIsManager(false);
        return;
      }

      // Hydrate the full employee row from the safe view. The view is
      // security_invoker; the `user_id = auth.uid()` SELECT policy on
      // employees lets the user read their own row regardless of HR
      // module permissions, so portal users always resolve.
      const { data: empData, error: empError } = await supabase
        .from("v_employees_safe" as any)
        .select("*")
        .eq("id", resolved.employee_id)
        .maybeSingle();

      if (empError) throw empError;

      if (empData) {
        const emp = empData as unknown as CurrentEmployee;
        setCurrentEmployee(emp);

        // Direct reports are scoped to the employee's OWN org/business
        // (from the resolver), not the client's currently-active business.
        if (emp.business_id) {
          const { data: reportsData, error: reportsError } = await supabase
            .from("v_employees_canonical")
            .select("id, employee_number, first_name, last_name, email, department_id")
            .eq("manager_id", emp.id)
            .eq("organization_id", emp.organization_id)
            .eq("business_id", emp.business_id)
            .eq("is_operationally_active", true);

          if (reportsError) throw reportsError;

          setDirectReports((reportsData || []) as DirectReport[]);
          setIsManager((reportsData || []).length > 0);
        } else {
          setDirectReports([]);
          setIsManager(false);
        }
      } else {
        setCurrentEmployee(null);
        setDirectReports([]);
        setIsManager(false);
      }
    } catch (error) {
      console.error("Error fetching current employee:", error);
      setCurrentEmployee(null);
      setDirectReports([]);
      setIsManager(false);
      setCanSelfLink(false);
    } finally {
      setIsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchCurrentEmployee();
  }, [fetchCurrentEmployee]);

  const isManagerOf = useCallback(
    (employeeId: string): boolean => {
      return directReports.some((r) => r.id === employeeId);
    },
    [directReports]
  );

  const getDirectReportIds = useCallback((): string[] => {
    return directReports.map((r) => r.id);
  }, [directReports]);

  return {
    currentEmployee,
    employeeOrgId,
    employeeBusinessId,
    directReports,
    isManager,
    isLoading,
    canSelfLink,
    isManagerOf,
    getDirectReportIds,
    refreshCurrentEmployee: fetchCurrentEmployee,
  };
}
