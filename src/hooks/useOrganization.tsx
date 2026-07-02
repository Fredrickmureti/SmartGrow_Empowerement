/**
 * useOrganization hook — canonical source for org/role/workspace data.
 *
 * Reads from `SessionContext` (the unified-session RPC), which is the single
 * source of truth. The legacy `@/contexts/OrganizationContext` was a
 * pass-through duplicate and has been removed (architecture audit Phase 3).
 *
 * Components that previously imported `OrganizationProvider` from
 * `@/contexts/OrganizationContext` should drop the wrapper entirely:
 * `SessionProvider` (mounted in App.tsx) already provides everything.
 *
 * The `OrganizationProvider` exported here is a no-op pass-through kept
 * only so callers that still mount it do not crash. New code must NOT
 * use it — it will be deleted in a follow-up sweep.
 */
import React from "react";
import { useOrganizationCompat } from "@/contexts/SessionContext";

// Re-export the Organization type for backward compatibility
export type { SessionOrganization as Organization } from "@/contexts/SessionContext";

export interface UserRole {
  id: string;
  role: "super_admin" | "owner" | "admin" | "accountant" | "staff" | "cashier" | "viewer";
  organization_id: string;
}

/**
 * Hook that provides organization data from the unified session
 */
export function useOrganization() {
  return useOrganizationCompat();
}

/**
 * @deprecated No-op shim. SessionProvider handles all org state. Do not wrap.
 */
export function OrganizationProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
