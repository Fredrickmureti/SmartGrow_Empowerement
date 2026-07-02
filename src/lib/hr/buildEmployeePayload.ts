import type { EmployeeFormData } from "@/components/employees/EmployeeFormDialog";

/**
 * Build the DB payload for create/update employee from form state.
 *
 * Wave 2: salary fields (`basic_salary`, `housing_allowance`,
 * `transport_allowance`, `other_allowances`) are NO LONGER written from this
 * payload. Compensation lives exclusively on `employee_contracts`. The
 * employee form has no salary inputs; the payroll engine reads contracts.
 *
 * Wave 2: employment lifecycle fields (`is_active`, `termination_date`) are
 * also NOT written from here — they are derived from `public.employments`
 * via the `sync_employee_from_employments` trigger. `hire_date` is still
 * written on create for backwards compatibility, but the auto-employment
 * trigger seeds the matching employment row.
 *
 * Legacy text columns `position` and `department` are intentionally NOT
 * written. Use `job_position_id` / `department_id` instead. Statutory
 * identifiers live in `employee_statutory_identifiers`.
 */
export function buildEmployeePayload(form: EmployeeFormData, opts: {
  user_id?: string | null;
  manager_id?: string | null;
}) {
  return {
    first_name: form.first_name,
    last_name: form.last_name,
    email: form.email || null,
    phone: form.phone || null,
    national_id: form.national_id || null,
    hire_date: form.hire_date,
    job_position_id: form.job_position_id || null,
    work_location_id: form.work_location_id || null,
    employment_type: form.employment_type,
    bank_name: form.bank_name || null,
    bank_branch: form.bank_branch || null,
    bank_account_number: form.bank_account_number || null,
    bank_code: form.bank_code || null,
    user_id: opts.user_id ?? null,
    manager_id: opts.manager_id ?? null,
    department_id: form.department_id || null,
    gender: form.gender || null,
    date_of_birth: form.date_of_birth || null,
    work_email: form.work_email || null,
    personal_phone: form.personal_phone || null,
    emergency_contact_name: form.emergency_contact_name || null,
    emergency_contact_phone: form.emergency_contact_phone || null,
    emergency_contact_relationship: form.emergency_contact_relationship || null,
    marital_status: form.marital_status || null,
    address_line1: form.address_line1 || null,
    address_line2: form.address_line2 || null,
    city: form.city || null,
    county: form.county || null,
    postal_code: form.postal_code || null,
    country: form.country || null,
  };
}

export function buildImportEmployeePayload(row: Record<string, any>) {
  // Salary intentionally omitted — must come in via contract import.
  // Pack/custom fields are handled out-of-band by splitImportedEmployeeRow;
  // this builder maps the core employee columns only, passing through
  // optional fields when the row provides them.
  const pick = (k: string) => (row[k] !== undefined && row[k] !== null && row[k] !== "" ? row[k] : null);
  return {
    first_name: row.first_name,
    last_name: row.last_name,
    email: pick("email"),
    phone: pick("phone"),
    hire_date: row.hire_date,
    national_id: pick("national_id"),
    bank_account_number: pick("bank_account_number"),
    bank_name: pick("bank_name"),
    bank_branch: pick("bank_branch"),
    bank_code: pick("bank_code"),
    employment_type: pick("employment_type") || "full_time",
    gender: pick("gender"),
    date_of_birth: pick("date_of_birth"),
    work_email: pick("work_email"),
    personal_phone: pick("personal_phone"),
    emergency_contact_name: pick("emergency_contact_name"),
    emergency_contact_phone: pick("emergency_contact_phone"),
    emergency_contact_relationship: pick("emergency_contact_relationship"),
    marital_status: pick("marital_status"),
    address_line1: pick("address_line1"),
    address_line2: pick("address_line2"),
    city: pick("city"),
    county: pick("county"),
    postal_code: pick("postal_code"),
    country: pick("country"),
    user_id: null,
    manager_id: null,
    department_id: null,
  };
}
