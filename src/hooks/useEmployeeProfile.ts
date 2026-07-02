import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface EmployeeProfile {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_number: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  national_id: string | null;
  // Statutory identifiers live in `employee_statutory_identifiers`
  // (see `useEmployeeStatutoryIdentifiers`).
  hire_date: string;
  termination_date: string | null;
  department: string | null;
  position: string | null;
  employment_type: string;
  bank_name: string | null;
  bank_branch: string | null;
  bank_account_number: string | null;
  bank_code: string | null;
  /** Active contract compensation (sourced from `employee_contracts` via `v_employees_safe`). */
  basic_salary: number | null;
  housing_allowance: number | null;
  transport_allowance: number | null;
  other_allowances: Record<string, number> | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  user_id: string | null;
  manager_id: string | null;
  department_id: string | null;
  avatar_url: string | null;
  user_access_status: string;
  gender: string | null;
  date_of_birth: string | null;
  work_email: string | null;
  personal_phone: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  marital_status: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postal_code: string | null;
  country: string | null;
  // Joined
  manager?: { id: string; first_name: string; last_name: string } | null;
  department_name?: string | null;
  managed_departments?: string[];
  lifecycle_status?: string;
}

export function useEmployeeProfile(employeeId: string | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [employee, setEmployee] = useState<EmployeeProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchEmployee = useCallback(async () => {
    if (!employeeId || !currentOrg || !currentBusiness?.id) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const { data: rawData, error } = await (supabase as any)
        .from("v_employees_safe")
        .select("*")
        .eq("id", employeeId)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .single();

      if (error) throw error;
      const data = rawData as any;

      // Fetch manager name (scoped to same company)
      let manager = null;
      if (data?.manager_id) {
        const { data: mgrData } = await supabase
          .from("v_employees_canonical")
          .select("id, first_name, last_name")
          .eq("id", data.manager_id)
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .single();
        manager = mgrData;
      }

      // Fetch departments this employee manages (scoped to same company)
      let managedDepartments: string[] = [];
      const { data: managedDepts } = await supabase
        .from("departments")
        .select("name")
        .eq("manager_id", data.id)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);
      if (managedDepts && managedDepts.length > 0) {
        managedDepartments = managedDepts.map((d: any) => d.name);
      }

      setEmployee({
        ...data,
        manager,
        department_name: data.department_name || null,
        managed_departments: managedDepartments,
        // lifecycle_status is now exposed directly by v_employees_safe (which
        // also excludes drafts, so any row returned is operational).
        lifecycle_status: data.lifecycle_status ?? "active",
      } as EmployeeProfile);
    } catch (error) {
      console.error("Error fetching employee profile:", error);
      toast.error("Failed to load employee profile");
      setEmployee(null);
    } finally {
      setIsLoading(false);
    }
  }, [employeeId, currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchEmployee();
  }, [fetchEmployee]);

  const updateEmployee = async (updates: Partial<EmployeeProfile>) => {
    if (!employee) return;
    try {
      // Strip joined/computed fields
      const { manager, department_name, managed_departments, ...dbUpdates } = updates as any;

      const { error } = await supabase
        .from("employees")
        .update(dbUpdates)
        .eq("id", employee.id);
      if (error) throw error;
      setEmployee((prev) => prev ? { ...prev, ...updates } : null);
      toast.success("Employee updated successfully");
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to update employee");
      throw error;
    }
  };

  return { employee, isLoading, updateEmployee, refreshEmployee: fetchEmployee };
}
