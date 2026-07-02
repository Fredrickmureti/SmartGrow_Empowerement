/**
 * useFinancePermission — client-side gate that mirrors the server-side
 * `has_finance_permission(uid, perm, business_id)` SQL function.
 *
 * IMPORTANT: this is a UX rail only. The DB enforces the same predicate
 * via RLS / RPCs. Never rely on this hook alone to protect data.
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
import { useEffect, useState } from "react";
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

export function useFinancePermission(perm: FinancePermission): {
  allowed: boolean;
  isLoading: boolean;
} {
  const { user } = useAuth();
  const { currentBusiness } = useBusinesses();
  const [allowed, setAllowed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id || !currentBusiness?.id) {
      setAllowed(false);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    (supabase as any)
      .rpc("has_finance_permission", {
        _user_id: user.id,
        _perm: perm,
        _business_id: currentBusiness.id,
      })
      .then(({ data, error }: { data: boolean | null; error: any }) => {
        if (cancelled) return;
        if (error) {
          console.warn("[useFinancePermission]", perm, error.message);
          setAllowed(false);
        } else {
          setAllowed(!!data);
        }
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, currentBusiness?.id, perm]);

  return { allowed, isLoading };
}
