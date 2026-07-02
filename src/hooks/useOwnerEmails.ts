import { supabase } from "@/integrations/supabase/client";

export interface OwnerEmailMap {
  [organizationId: string]: string | null;
}

/**
 * Fetches owner emails for all organizations by joining user_roles + profiles.
 * Returns a map of organization_id -> owner email.
 */
export async function fetchOwnerEmails(organizationIds?: string[]): Promise<OwnerEmailMap> {
  // Fetch owner roles
  let query = supabase
    .from("user_roles")
    .select("organization_id, user_id")
    .eq("role", "owner")
    .eq("is_active", true);

  if (organizationIds && organizationIds.length > 0) {
    query = query.in("organization_id", organizationIds);
  }

  const { data: ownerRoles, error: rolesError } = await query;
  if (rolesError || !ownerRoles?.length) return {};

  // Fetch profiles for owner user_ids
  const userIds = [...new Set(ownerRoles.map(r => r.user_id))];
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("user_id, email")
    .in("user_id", userIds);

  if (profilesError || !profiles) return {};

  const profileMap = new Map<string, string>(profiles.map((p: any) => [p.user_id as string, p.email as string]));

  // Build org -> owner email map
  const result: OwnerEmailMap = {};
  for (const role of ownerRoles) {
    result[role.organization_id] = (profileMap.get(role.user_id) as string) || null;
  }
  return result;
}
