/**
 * Natural-key resolver for the employee importer.
 *
 * Translates user-friendly columns (department name, position name, manager
 * email, work-location name) into the corresponding *_id values written to
 * `public.employees`. Resolution is case-insensitive, scoped to the active
 * organization/business. Unresolved values become `null` and a warning is
 * returned so the caller can surface it to the user.
 */
import { supabase } from "@/integrations/supabase/client";

export interface ResolvedNaturalKeys {
  department_id: string | null;
  job_position_id: string | null;
  work_location_id: string | null;
  manager_id: string | null;
  warnings: string[];
}

export interface ResolveInput {
  organizationId: string;
  businessId?: string | null;
  department?: string | null;
  position?: string | null;
  workLocation?: string | null;
  managerEmail?: string | null;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

async function lookupId(
  table: "departments" | "job_positions" | "work_locations",
  nameCol: string,
  needle: string,
  organizationId: string,
  businessId?: string | null,
): Promise<string | null> {
  let q = (supabase as any)
    .from(table)
    .select(`id, ${nameCol}, business_id`)
    .eq("organization_id", organizationId);
  if (businessId) q = q.or(`business_id.is.null,business_id.eq.${businessId}`);
  const { data, error } = await q;
  if (error || !Array.isArray(data)) return null;
  const target = norm(needle);
  // Prefer business-scoped match if both exist.
  const matches = data.filter((r: any) => norm(r[nameCol]) === target);
  if (matches.length === 0) return null;
  matches.sort((a: any, b: any) => (b.business_id ? 1 : 0) - (a.business_id ? 1 : 0));
  return matches[0].id as string;
}

export async function resolveEmployeeNaturalKeys(
  input: ResolveInput,
): Promise<ResolvedNaturalKeys> {
  const warnings: string[] = [];
  const out: ResolvedNaturalKeys = {
    department_id: null,
    job_position_id: null,
    work_location_id: null,
    manager_id: null,
    warnings,
  };

  if (input.department) {
    out.department_id = await lookupId("departments", "name", input.department, input.organizationId, input.businessId);
    if (!out.department_id) warnings.push(`Department "${input.department}" not found — left blank.`);
  }

  if (input.position) {
    out.job_position_id = await lookupId("job_positions", "title", input.position, input.organizationId, input.businessId);
    if (!out.job_position_id) warnings.push(`Position "${input.position}" not found — left blank.`);
  }

  if (input.workLocation) {
    out.work_location_id = await lookupId("work_locations", "name", input.workLocation, input.organizationId, input.businessId);
    if (!out.work_location_id) warnings.push(`Work location "${input.workLocation}" not found — left blank.`);
  }

  if (input.managerEmail) {
    const email = input.managerEmail.trim().toLowerCase();
    let q = (supabase as any)
      .from("v_employees_canonical")
      .select("id, email, work_email, business_id")
      .eq("organization_id", input.organizationId)
      .or(`email.eq.${email},work_email.eq.${email}`);
    const { data, error } = await q;
    if (!error && Array.isArray(data) && data.length > 0) {
      const sorted = (data as any[]).sort(
        (a, b) => (b.business_id === input.businessId ? 1 : 0) - (a.business_id === input.businessId ? 1 : 0),
      );
      out.manager_id = sorted[0].id;
    } else {
      warnings.push(`Manager with email "${input.managerEmail}" not found — left blank.`);
    }
  }

  return out;
}
