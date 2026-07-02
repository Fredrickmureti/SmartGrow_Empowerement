/**
 * useBranches — single source of truth.
 *
 * Re-exports BranchContext so every consumer reads from one in-memory cache.
 * The previous standalone implementation that re-queried the DB has been
 * removed (Odoo-aligned: one branch list per active company per session).
 *
 * Compatibility: callers that pass a businessId (e.g. CreateBranchDialog)
 * are scoped by the active BusinessContext anyway, so the parameter is
 * ignored. If you need cross-company branch listing, call Supabase directly.
 */
export { useBranch as useBranches, BranchProvider } from "@/contexts/BranchContext";
export type { Branch, CreateBranchInput } from "@/contexts/BranchContext";
