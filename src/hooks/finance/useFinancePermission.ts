/**
 * useFinancePermission — client-side gate that mirrors the server-side
 * `has_finance_permission(uid, perm, business_id)` SQL function.
 *
 * IMPORTANT: this is a UX rail only. The DB enforces the same predicate
 * via RLS / RPCs. Never rely on this hook alone to protect data.
 *
 * TRI-STATE CONTRACT (Odoo / Xero / NetSuite parity): a permission is
 * `loading`, `allowed` or `denied` — never "denied because we haven't
 * asked yet". Callers MUST NOT render a denial banner while `isLoading`
 * is true; render the normal skeleton / disabled state instead.
 *
 * Permission keys (kept in sync with DB):
 *   - finance.view_branch         (default for all finance users)
 *   - finance.view_consolidated   (HQ aggregate / cross-branch totals)
 *   - finance.manage_je           (create/edit manual journal entries)
 *   - finance.void_je             (void/reverse journal entries)
 *   - finance.manage_coa          (chart of accounts edits, import, defaults)
 *   - finance.manage_periods      (open/close fiscal periods, lock dates)
 *   - finance.manage_settings     (finance settings page, mappings)
 *   - finance.reconcile_bank      (bank reconciliation sessions)
 *   - finance.export_reports      (financial report PDF/CSV export)
 */
import { useQueries } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinesses } from "@/hooks/useBusinesses";

export type FinancePermission =
  | "finance.view_branch"
  | "finance.view_consolidated"
  | "finance.manage_je"
  | "finance.void_je"
  | "finance.manage_coa"
  | "finance.manage_periods"
  | "finance.manage_settings"
  | "finance.reconcile_bank"
  | "finance.export_reports"
  | "finance.manage_budgets"
  | "finance.manage_assets"
  | "finance.manage_bank_accounts";

export interface FinancePermissionState {
  /** True only when the server answered "yes". */
  allowed: boolean;
  /**
   * True while the user, the active company, or the RPC answer is still
   * unresolved. A null company is LOADING, not DENIED.
   */
  isLoading: boolean;
  /** Convenience: the answer is settled (allowed or denied is meaningful). */
  isReady: boolean;
}

async function fetchFinancePermission(
  userId: string,
  businessId: string,
  perm: FinancePermission,
): Promise<boolean> {
  const { data, error } = await (supabase as any).rpc("has_finance_permission", {
    _user_id: userId,
    _perm: perm,
    _business_id: businessId,
  });
  if (error) {
    console.warn("[useFinancePermission]", perm, error.message);
    return false;
  }
  return !!data;
}

/**
 * Batch variant — resolves several permissions with one cached query each
 * (React Query dedupes identical keys across components, so a page that
 * asks for the same permission in three cards makes ONE round-trip).
 */
export function useFinancePermissions(
  perms: FinancePermission[],
): { permissions: Record<string, boolean>; isLoading: boolean; isReady: boolean } {
  const { user } = useAuth();
  const { currentBusiness, isLoading: businessLoading } = useBusinesses();
  const userId = user?.id ?? null;
  const businessId = currentBusiness?.id ?? null;
  const contextLoading = businessLoading || !userId || !businessId;

  const results = useQueries({
    queries: perms.map((perm) => ({
      queryKey: ["finance-permission", userId, businessId, perm],
      queryFn: () => fetchFinancePermission(userId!, businessId!, perm),
      enabled: !!userId && !!businessId,
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
    })),
  });

  const permissions: Record<string, boolean> = {};
  perms.forEach((perm, i) => {
    permissions[perm] = results[i]?.data === true;
  });

  const isLoading = contextLoading || results.some((r) => r.isLoading);

  return { permissions, isLoading, isReady: !isLoading };
}

export function useFinancePermission(perm: FinancePermission): FinancePermissionState {
  const { permissions, isLoading } = useFinancePermissions([perm]);
  return {
    allowed: permissions[perm] === true,
    isLoading,
    isReady: !isLoading,
  };
}
