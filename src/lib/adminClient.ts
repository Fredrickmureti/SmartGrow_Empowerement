/**
 * Admin Supabase Client Helper
 * 
 * The admin panel references tables (organizations, profiles, user_roles, etc.)
 * that exist in the database but are not in the auto-generated types.ts
 * (which only contains the original schema tables).
 * 
 * This helper provides a typed-safe way to access those tables without
 * scattering `as any` casts throughout admin components.
 */
import { supabase } from "@/integrations/supabase/client";

/**
 * Access a Supabase table that exists in the database but isn't in the
 * auto-generated types. Returns an untyped query builder.
 * 
 * Usage:
 *   const { data } = await adminFrom("organizations").select("*").eq("id", orgId);
 */
export function adminFrom(table: string) {
  return (supabase.from as any)(table);
}

export { supabase };
