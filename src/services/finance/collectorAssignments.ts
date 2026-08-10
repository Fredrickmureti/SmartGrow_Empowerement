/**
 * Collector assignment service.
 *
 * Maps customers (contacts) to the staff member responsible for collecting
 * their outstanding receivables. Assignments are org-scoped and single-active
 * per contact — the database RPC `upsert_collector_assignment` deactivates any
 * prior active assignment before inserting the new one.
 */
import { supabase } from "@/integrations/supabase/client";

export interface CollectorAssignment {
  id: string;
  contactId: string;
  collectorUserId: string;
  collectorName: string;
  collectorEmail: string;
  active: boolean;
  assignedAt: string;
}

export interface OrgMember {
  userId: string;
  fullName: string;
  email: string;
}

/**
 * Fetch all active collector assignments for the organization, joined with
 * the collector's profile (email + full_name) so the UI can show a name
 * without a second round-trip.
 */
export async function fetchCollectorAssignments(
  orgId: string,
  businessId?: string | null,
): Promise<Map<string, CollectorAssignment>> {
  let q = supabase
    .from("collector_assignments" as any)
    .select(
      "id, contact_id, collector_user_id, active, assigned_at, user_roles!inner(email, full_name)",
    )
    .eq("active", true)
    .order("assigned_at", { ascending: false });

  // We need to filter by organization but the table doesn't expose org_id
  // in a way Supabase client can easily join. Use the RPC instead.
  const { data, error } = await supabase.rpc("fetch_collector_assignments_with_names", {
    _org_id: orgId,
  });

  if (error) throw error;

  const map = new Map<string, CollectorAssignment>();
  for (const r of (data || []) as any[]) {
    map.set(r.contact_id, {
      id: r.id,
      contactId: r.contact_id,
      collectorUserId: r.collector_user_id,
      collectorName: r.collector_name || "Unknown",
      collectorEmail: r.collector_email || "",
      active: r.active,
      assignedAt: r.assigned_at,
    });
  }
  return map;
}

/**
 * Fetch active org members who can be assigned as collectors.
 */
export async function fetchOrgMembers(orgId: string): Promise<OrgMember[]> {
  const { data, error } = await supabase
    .from("user_roles" as any)
    .select("user_id, full_name, email, raw_user_meta_data")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .order("full_name" as any, { ascending: true });

  if (error) {
    // user_roles may not have full_name/email columns directly. Fall back to
    // auth.users metadata via a simpler query.
    const { data: fallback, error: err2 } = await supabase
      .from("user_roles" as any)
      .select("user_id, email")
      .eq("organization_id", orgId)
      .eq("is_active", true);

    if (err2) throw err2;
    return (fallback || []).map((r: any) => ({
      userId: r.user_id,
      fullName: r.email?.split("@")[0] || "Unknown",
      email: r.email || "",
    }));
  }

  return (data || []).map((r: any) => ({
    userId: r.user_id,
    fullName: r.full_name || r.email?.split("@")[0] || "Unknown",
    email: r.email || "",
  }));
}

/**
 * Assign a collector to a contact. Deactivates any prior active assignment.
 */
export async function assignCollector(
  contactId: string,
  collectorUserId: string,
  businessId?: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc("upsert_collector_assignment", {
    _contact_id: contactId,
    _collector_user_id: collectorUserId,
    _business_id: businessId ?? null,
  });

  if (error) throw error;
  return data as string;
}

/**
 * Unassign the active collector from a contact.
 */
export async function unassignCollector(contactId: string): Promise<void> {
  const { error } = await supabase.rpc("deactivate_collector_assignment", {
    _contact_id: contactId,
  });
  if (error) throw error;
}
