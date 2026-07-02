/**
 * saveEmployeeForm — single source of truth for persisting an EmployeeFormData
 * from any surface (the modal in `pages/Employees.tsx`, the full-page route
 * `EmployeeNewPage`, or future quick-add flows).
 *
 * Mirrors the inline logic that previously lived inside `Employees.handleSubmit`,
 * keeping create / update parity, statutory identifier persistence, and the
 * country-code guard. Returns the saved employee id.
 */
import { supabase } from "@/integrations/supabase/client";
import type { EmployeeFormData } from "@/components/employees/EmployeeFormDialog";
import type { Employee } from "@/hooks/useEmployees";
import { buildEmployeePayload } from "@/lib/hr/buildEmployeePayload";

export interface SaveEmployeeFormArgs {
  form: EmployeeFormData;
  editingEmployee: Employee | null;
  organizationId: string | null | undefined;
  businessId: string | null | undefined;
  countryCode: string;
  updateEmployee: (id: string, payload: any) => Promise<any>;
  /** When true, create the row with lifecycle_status='draft'. Default 'active'. */
  asDraft?: boolean;
}

export interface SaveEmployeeFormResult {
  employeeId: string;
  /** When non-null, the caller should surface this to the user (toast). */
  warning?: string;
}

export class CountryCodeMissingError extends Error {
  constructor() {
    super("Set the company country in Settings before saving statutory identifiers.");
    this.name = "CountryCodeMissingError";
  }
}

export async function saveEmployeeForm(
  args: SaveEmployeeFormArgs,
): Promise<SaveEmployeeFormResult> {
  const { form, editingEmployee, organizationId, businessId, countryCode, updateEmployee, asDraft } = args;

  const payload: any = buildEmployeePayload(form, {
    user_id: editingEmployee?.user_id ?? null,
    manager_id: editingEmployee?.manager_id ?? null,
  });

  let employeeId: string;

  if (editingEmployee) {
    await updateEmployee(editingEmployee.id, payload);
    employeeId = editingEmployee.id;

    // Edit-mode identifier sync (delete + re-insert non-empty rows).
    const entries = Object.entries(form.statutory_identifiers ?? {});
    if (entries.length > 0 && organizationId) {
      if (!countryCode) throw new CountryCodeMissingError();
      const types = entries.map(([k]) => k);
      await supabase
        .from("employee_statutory_identifiers")
        .delete()
        .eq("employee_id", employeeId)
        .in("identifier_type", types);
      const toInsert = entries
        .filter(([, v]) => (v ?? "").trim() !== "")
        .map(([identifier_type, identifier_value]) => ({
          employee_id: employeeId,
          organization_id: organizationId,
          business_id: businessId ?? null,
          country_code: countryCode,
          identifier_type,
          identifier_value: (identifier_value as string).trim(),
          is_active: true,
        }));
      if (toInsert.length > 0) {
        const { error } = await supabase
          .from("employee_statutory_identifiers")
          .insert(toInsert as any);
        if (error) throw error;
      }
    }
    return { employeeId };
  }

  // Create-mode: atomic RPC handles employee + identifiers in one transaction.
  const identifiers = Object.entries(form.statutory_identifiers ?? {})
    .filter(([, v]) => (v ?? "").trim() !== "")
    .map(([identifier_type, identifier_value]) => ({
      identifier_type,
      identifier_value: identifier_value as string,
    }));
  if (identifiers.length > 0 && !countryCode) throw new CountryCodeMissingError();

  const employeePayload: any = {
    ...payload,
    organization_id: organizationId ?? null,
    business_id: businessId ?? null,
    lifecycle_status: asDraft ? "draft" : "active",
    _country_code: countryCode || null,
  };
  // `employees.hire_date` is NOT NULL date — empty string would 400 on
  // jsonb_populate_record. For drafts, default to today so auto-save can
  // succeed before the user has filled the Employment tab.
  if (!employeePayload.hire_date || String(employeePayload.hire_date).trim() === "") {
    if (asDraft) {
      employeePayload.hire_date = new Date().toISOString().slice(0, 10);
    } else {
      delete employeePayload.hire_date;
    }
  }
  // Strip any other empty-string date fields so Postgres doesn't reject them.
  for (const k of ["date_of_birth"]) {
    if (employeePayload[k] === "") employeePayload[k] = null;
  }
  const { data: newId, error: rpcErr } = await supabase.rpc(
    "create_employee_with_identifiers" as any,
    { p_employee: employeePayload, p_identifiers: identifiers },
  );
  if (rpcErr) throw rpcErr;
  return { employeeId: newId as unknown as string };
}