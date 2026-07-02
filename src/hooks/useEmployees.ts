import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { toast as sonnerToast } from "sonner";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "./usePermissions";
import { toast } from "sonner";
import { triggerAutomation, getChangedFields } from "@/lib/automations/triggerAutomation";
import { assertHrScope } from "@/lib/hr/scopingAssertions";
import { useHrScope } from "./hr/useHrScope";

export interface Employee {
  id: string;
  organization_id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  national_id: string | null;
  // Statutory identifiers (tax_pin/NSSF/SHIF/NHIF, etc.) live in the
  // generic `employee_statutory_identifiers` table — read via
  // `useEmployeeStatutoryIdentifiers(employeeId)`.
  hire_date: string;
  termination_date: string | null;
  department: string | null;
  position: string | null;
  employment_type: string;
  bank_name: string | null;
  bank_branch: string | null;
  bank_account_number: string | null;
  bank_code: string | null;
  basic_salary: number;
  housing_allowance: number;
  transport_allowance: number;
  other_allowances: Record<string, number> | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  emergency_contact_relationship: string | null;
  marital_status: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postal_code: string | null;
  country: string | null;
  // New ERP fields
  user_id: string | null;
  manager_id: string | null;
  department_id: string | null;
  // Joined data
  manager?: {
    id: string;
    first_name: string;
    last_name: string;
  };
  department_name?: string | null;
  lifecycle_status?: string;
}

export type EmployeeStatusFilter = "active_only" | "drafts" | "all";

export function useEmployees(options?: { enabled?: boolean; status?: EmployeeStatusFilter }) {
  const enabled = options?.enabled ?? true;
  const statusFilter: EmployeeStatusFilter = options?.status ?? "active_only";
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { can } = usePermissions();
  const { isBranchRestricted, branchIds } = useHrScope();
  const canViewEmployees = can("viewEmployees");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);

  const fetchEmployees = useCallback(async () => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    // Wait for BOTH org and business to resolve. On hard reload `currentOrg`
    // settles a tick before `currentBusiness`; without this guard we deref
    // `currentBusiness!.id` below and crash.
    if (!currentOrg?.id || !currentBusiness?.id) {
      setEmployees([]);
      setIsLoading(false);
      return;
    }
    assertHrScope({ hook: "useEmployees", orgId: currentOrg.id, businessId: currentBusiness.id });

    // Defense-in-depth: if user lacks viewEmployees, don't fetch all employees
    if (!canViewEmployees) {
      setEmployees([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    try {
      // Single canonical read path (Phase B/D consolidation): every status
      // filter is expressed against `v_employees_canonical`, the one view
      // that owns the lifecycle predicates. The legacy `v_employee_drafts`
      // and `v_employees_safe` forks were removed because they answered the
      // same business question with subtly different WHERE clauses.
      let query = (supabase as any)
        .from("v_employees_canonical")
        .select("*", { count: "exact" })
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);

      if (statusFilter === "drafts") {
        query = query.eq("lifecycle_bucket", "draft");
      } else if (statusFilter === "active_only") {
        query = query.eq("is_operationally_active", true);
      } else {
        // 'all' = everything visible in the directory (excludes drafts and
        // archived rows — those have dedicated entry points).
        query = query.eq("is_directory_visible", true);
      }

      // Phase B (HR Architecture Review): the directory is BUSINESS-scoped,
      // not branch-partitioned. Branch is an assignment (0..N per employee),
      // not an ownership column, so we never hard-filter by `branch_id` here.
      // Visibility for branch-restricted users is enforced server-side via
      // RLS + `v_employee_branch_scope` (HQ/remote employees with no
      // assignment remain visible to every branch). The Branch dropdown in
      // the toolbar applies a non-destructive *display* filter on top of
      // this list — it never hides ownership.

      const { data, error } = await query
        .order("first_name", { ascending: true })
        .range(0, 4999); // Support up to 5000 employees

      if (error) throw error;

      const rows = (data ?? []) as any[];
      const managerIds = [
        ...new Set(rows.filter((e) => e.manager_id).map((e) => e.manager_id)),
      ];

      let managers: Record<string, { id: string; first_name: string; last_name: string }> = {};
      if (managerIds.length > 0) {
        // Plan D2: manager lookup must NEVER hit the base table directly —
        // that returns drafts/archived rows and bypasses RLS-aware PII
        // masking. Go through the canonical safe view.
        const { data: managerData } = await (supabase as any)
          .from("v_employees_safe")
          .select("id, first_name, last_name")
          .in("id", managerIds);
        if (managerData) {
          managers = Object.fromEntries(
            (managerData as any[]).map((m) => [m.id, m]),
          );
        }
      }

      const enriched: Employee[] = rows.map((emp) => ({
        ...emp,
        manager: emp.manager_id ? managers[emp.manager_id] : null,
        department_name: emp.department_name ?? null,
        // lifecycle_status now comes straight from the view — no secondary
        // round-trip required.
        lifecycle_status: emp.lifecycle_status ?? (statusFilter === "drafts" ? "draft" : "active"),
      }));

      setEmployees(enriched);
    } catch (error) {
      console.error("Error fetching employees:", error);
      toast.error("Failed to fetch employees");
    } finally {
      setIsLoading(false);
    }
  }, [enabled, statusFilter, currentOrg?.id, currentBusiness?.id, canViewEmployees, isBranchRestricted, branchIds.join(",")]);

  useEffect(() => {
    fetchEmployees();
  }, [fetchEmployees]);

  const getNextEmployeeNumber = async (): Promise<string> => {
    if (!currentOrg || !currentBusiness) return "EMP-0001";

    const { data, error } = await supabase.rpc("get_next_employee_number", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
    });

    if (error) {
      console.error("Error getting employee number:", error);
      return `EMP-${Date.now()}`;
    }

    return data || "EMP-0001";
  };

  const createEmployee = async (
    employee: Omit<Employee, "id" | "organization_id" | "employee_number" | "created_at" | "updated_at">
  ) => {
    if (!currentOrg || !user) throw new Error("No organization selected");
    if (!can("manageEmployees")) {
      toast.error("You don't have permission to create employees");
      throw new Error("Permission denied");
    }

    // Strip joined fields before insert
    const { manager, department_name, lifecycle_status, ...dbEmployee } = employee as any;

    // Phase 1: route every employee create through the canonical RPC.
    // `create_employee_with_identifiers` owns:
    //   - employee_number generation (no client-side race window)
    //   - statutory identifier atomic insert (no half-created rows)
    //   - lifecycle_status / draft_owner_id stamping
    //   - country-code validation
    // The raw INSERT previously here was the legacy second writer the
    // Employee architecture audit flagged. It is intentionally gone.
    const employeePayload = {
      ...dbEmployee,
      organization_id: currentOrg.id,
      business_id: currentBusiness?.id || null,
      lifecycle_status: "active",
      _country_code: ((currentBusiness as any)?.country || "").toUpperCase().trim() || null,
    };
    // hire_date is NOT NULL — let the RPC reject empty values explicitly
    // rather than 400-ing on jsonb_populate_record.
    if (!employeePayload.hire_date || String(employeePayload.hire_date).trim() === "") {
      delete employeePayload.hire_date;
    }
    for (const k of ["date_of_birth", "termination_date"]) {
      if (employeePayload[k] === "") employeePayload[k] = null;
    }

    const { data: newId, error: rpcErr } = await supabase.rpc(
      "create_employee_with_identifiers" as any,
      { p_employee: employeePayload, p_identifiers: [] },
    );
    if (rpcErr) throw rpcErr;
    const employeeId = newId as unknown as string;

    // Re-fetch the persisted row through the canonical PII-masking view so
    // optimistic state and downstream auto-link logic see the same shape as
    // the directory.
    const { data } = await (supabase as any)
      .from("v_employees_safe")
      .select("*")
      .eq("id", employeeId)
      .maybeSingle();

    // Auto-link: if the new employee's email matches an org member, set user_id
    if (data && data.email && !data.user_id) {
      try {
        // Find a profile with matching email
        const { data: profileMatch } = await supabase
          // SCOPE-EXEMPT: `profiles` is workspace-wide (no business_id column)
          .from("profiles")
          .select("id, user_id")
          .ilike("email", data.email)
          .maybeSingle();

        if (profileMatch?.user_id) {
          // Verify this user is a member of the current org
          const { data: roleMatch } = await supabase
            .from("user_roles")
            .select("id")
            .eq("user_id", profileMatch.user_id)
            .eq("organization_id", currentOrg.id)
            .maybeSingle();

          if (roleMatch) {
            // Check no other employee is already linked to this user in this org
            const { data: existingLink } = await (supabase as any)
              .from("v_employees_canonical")
              .select("id")
              .eq("user_id", profileMatch.user_id)
              .eq("organization_id", currentOrg.id)
              .eq("business_id", currentBusiness?.id || "")
              .eq("is_directory_visible", true)
              .maybeSingle();

            if (!existingLink) {
              // Route every employee↔user link through the audited RPC so
              // owner / admin / platform-admin / self protections fire.
              const { error: linkErr } = await supabase.rpc(
                "link_employee_to_user" as any,
                { p_employee_id: employeeId, p_user_id: profileMatch.user_id, p_force: false },
              );
              if (!linkErr) {
                (data as any).user_id = profileMatch.user_id;
                sonnerToast.info("Employee automatically linked to their user account");
              }
            }

          }
        }
      } catch (linkErr) {
        console.warn("Auto-link attempt failed (non-fatal):", linkErr);
      }
    }

    sonnerToast.success(`Employee ${(data as any)?.employee_number ?? ""} created successfully`);
    // Optimistic update
    if (data) {
      setEmployees((prev) => [...prev, data as unknown as Employee].sort((a, b) => a.first_name.localeCompare(b.first_name)));
    }

    // Trigger automations (fire-and-forget)
    if (currentOrg && data) {
      triggerAutomation({
        event_type: "on_create",
        target_model: "employee",
        record_id: (data as any).id,
        record_data: data as unknown as Record<string, unknown>,
        organization_id: currentOrg.id,
      });
    }

    return data;
  };


  const updateEmployee = async (id: string, updates: Partial<Employee>) => {
    if (!can("manageEmployees")) {
      toast.error("You don't have permission to update employees");
      throw new Error("Permission denied");
    }
    // Optimistic update
    setEmployees((prev) => prev.map((e) => (e.id === id ? { ...e, ...updates } : e)));

    // Strip joined fields
    const { manager, department_name, ...dbUpdates } = updates as any;

    const { error } = await supabase
      .from("employees")
      .update(dbUpdates)
      .eq("id", id);

    if (error) throw error;
    toast.success("Employee updated successfully");

    // Trigger automations (fire-and-forget; must never break the update flow)
    if (currentOrg) {
      try {
        let employee = employees.find((e) => e.id === id) as unknown as Record<string, unknown> | undefined;
        if (!employee) {
          // Local cache miss (just-created row, filtered list, etc.) — fetch
          // the pre-update snapshot so automations get accurate old_data.
          const { data: fetched } = await supabase
            .from("employees")
            .select("*")
            .eq("id", id)
            .maybeSingle();
          employee = (fetched ?? {}) as Record<string, unknown>;
        }
        const changedFields = getChangedFields(employee, updates as Record<string, unknown>);
        void triggerAutomation({
          event_type: changedFields.length > 0 ? "field_change" : "on_update",
          target_model: "employee",
          record_id: id,
          record_data: { ...employee, ...updates } as Record<string, unknown>,
          old_data: employee,
          changed_fields: changedFields,
          organization_id: currentOrg.id,
        }).catch((e) => console.warn("[updateEmployee] automation trigger failed:", e));
      } catch (e) {
        console.warn("[updateEmployee] automation pre-step failed:", e);
      }
    }
  };

  const deleteEmployee = async (id: string) => {
    if (!can("manageEmployees")) {
      toast.error("You don't have permission to delete employees");
      throw new Error("Permission denied");
    }
    const emp = employees.find((e) => e.id === id);
    if (emp?.is_active) {
      // Hard delete is reserved for inactive / never-onboarded employees.
      // Active employees must go through the Terminate (offboard) flow so
      // employment spells, payouts and audit trail are recorded correctly.
      toast.error("Active employees can't be deleted. Use Terminate to offboard.");
      throw new Error("Active employee — use Terminate");
    }

    // Optimistic removal
    setEmployees((prev) => prev.filter((e) => e.id !== id));

    // Real hard delete. The DB enforces context-awareness via FK
    // constraints: if any contract, payslip, payroll line, leave row,
    // attendance event, etc. references this employee the delete is
    // refused (Postgres error 23503) and we surface a clear message
    // telling the user to use Terminate instead.
    const { error } = await supabase
      .from("employees")
      .delete()
      .eq("id", id);

    if (error) {
      if (emp) setEmployees((prev) => [...prev, emp]);
      const code = (error as any).code;
      if (code === "23503") {
        toast.error(
          "This employee has linked records (contracts, payroll, leave, attendance…). Use Terminate to offboard instead of deleting.",
        );
      } else {
        toast.error(error.message || "Failed to delete employee");
      }
      throw error;
    }
    toast.success("Employee deleted permanently");

    // Trigger automations (fire-and-forget)
    if (currentOrg && emp) {
      triggerAutomation({
        event_type: "on_delete",
        target_model: "employee",
        record_id: emp.id,
        record_data: emp as unknown as Record<string, unknown>,
        organization_id: currentOrg.id,
      });
    }
  };


  const calculateGrossPay = (employee: Employee): number => {
    const basicSalary = employee.basic_salary || 0;
    const housingAllowance = employee.housing_allowance || 0;
    const transportAllowance = employee.transport_allowance || 0;
    const otherAllowances = Object.values(employee.other_allowances || {}).reduce(
      (sum, val) => sum + (val || 0),
      0
    );
    return basicSalary + housingAllowance + transportAllowance + otherAllowances;
  };

  return {
    employees,
    activeEmployees: employees.filter((e) => e.is_active),
    isLoading,
    getNextEmployeeNumber,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    calculateGrossPay,
    refreshEmployees: fetchEmployees,
  };
}
