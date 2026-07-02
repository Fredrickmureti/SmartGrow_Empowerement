/**
 * C-HR-4 — Audited PII reader.
 *
 * Calls the SECURITY DEFINER `get_employee_pii` RPC, which validates that
 * the caller is either the employee themselves or has both
 * `viewEmployeePrivate` + `viewEmployeePayroll`, then writes an
 * `employee.pii.read` row to `audit_logs` before returning the raw values.
 *
 * Components should only call this hook when the user explicitly
 * requests to "Reveal sensitive details" — never on initial render.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface EmployeePii {
  national_id: string | null;
  date_of_birth: string | null;
  personal_phone: string | null;
  gender: string | null;
  marital_status: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postal_code: string | null;
  country: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  bank_name: string | null;
  bank_branch: string | null;
  bank_account_number: string | null;
  bank_code: string | null;
}

export function useEmployeePii(employeeId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["employee-pii", employeeId],
    enabled: !!employeeId && enabled,
    staleTime: 60_000,
    gcTime: 60_000,
    queryFn: async (): Promise<EmployeePii> => {
      const { data, error } = await supabase.rpc("get_employee_pii" as any, {
        p_employee_id: employeeId,
      });
      if (error) throw error;
      return data as EmployeePii;
    },
  });
}
