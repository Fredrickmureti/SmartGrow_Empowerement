/**
 * Employee graph helpers used by talent-domain features (goals,
 * development plans, reviews, 1-on-1s). Centralizes the
 * `v_employees_canonical` lookups that were previously duplicated across
 * hooks. Only reads — no writes.
 */
import { supabase } from "@/integrations/supabase/client";

export interface EmployeeManagerInfo {
  id: string;
  manager_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

/**
 * Resolve the manager employee_id and the reportee's display name for a
 * single employee id via `v_employees_canonical`. Returns `null` when
 * the employee cannot be resolved. Callers should treat `manager_id`
 * being null as "no manager" (top of tree or vacancy).
 */
export async function getManagerFor(
  employeeId: string,
): Promise<EmployeeManagerInfo | null> {
  const { data, error } = await (supabase as any)
    .from("v_employees_canonical")
    .select("id, manager_id, first_name, last_name")
    .eq("id", employeeId)
    .maybeSingle();
  if (error) return null;
  return (data as EmployeeManagerInfo) ?? null;
}

/** Convenience: full "First Last" string, trimmed, or `fallback`. */
export function displayName(
  emp: Pick<EmployeeManagerInfo, "first_name" | "last_name"> | null | undefined,
  fallback = "Employee",
): string {
  if (!emp) return fallback;
  const s = `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim();
  return s || fallback;
}
