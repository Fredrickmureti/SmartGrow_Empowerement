import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useFinanceScope } from "./finance/useFinanceScope";
import { financeKey } from "@/lib/finance/financeKey";

/**
 * useControlAccountReconciliation
 *
 * Calls the atomic `get_control_account_reconciliation` RPC which returns
 * sub_ledger_total, gl_closing, drift, opening_balance, and has_migration_je
 * in a SINGLE round-trip. This eliminates the AR/AP "drift flicker" that
 * previously appeared on reload when two independent queries (sub-ledger
 * total + GL balance) refetched at different speeds and produced an
 * intermediate inconsistent state.
 *
 * Uses `placeholderData: keepPreviousData` so that during background
 * refetches the previous coherent verdict stays on screen — the UI never
 * renders a derived "drift" state from partially refreshed data.
 *
 * Sub-ledger filter and migration-aware opening balance handling are both
 * authoritative on the server side inside the RPC.
 */
export function useControlAccountReconciliation(reportType: "ar" | "ap") {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();

  const query = useQuery({
    // CRITICAL: branchId is part of the cache key so switching branches
    // forces a refetch and the AR/AP card never shows stale numbers from
    // the previously-active scope.
    queryKey: financeKey(scope, "control-account-recon-rpc", reportType),
    queryFn: async () => {
      if (!currentOrg?.id) {
        return {
          control_account_id: null as string | null,
          sub_ledger_total: 0,
          gl_closing: 0,
          opening_balance: 0,
          has_migration_je: false,
          drift: 0,
          has_drift: false,
        };
      }

      const { data, error } = await supabase.rpc(
        "get_control_account_reconciliation" as any,
        {
          _org_id: currentOrg.id,
          _business_id: currentBusiness?.id || null,
          _report_type: reportType,
          _branch_id: scope.rpcBranchId,
        } as any,
      );

      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      return {
        control_account_id: (row?.control_account_id as string | null) ?? null,
        sub_ledger_total: Number(row?.sub_ledger_total) || 0,
        gl_closing: Number(row?.gl_closing) || 0,
        opening_balance: Number(row?.opening_balance) || 0,
        has_migration_je: !!row?.has_migration_je,
        drift: Number(row?.drift) || 0,
        has_drift: !!row?.has_drift,
      };
    },
    enabled: !!currentOrg?.id,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const d = query.data;

  return {
    controlAccountId: d?.control_account_id ?? null,
    isConfigured: !!d?.control_account_id,
    subLedgerTotal: d?.sub_ledger_total ?? 0,
    glClosingBalance: d?.gl_closing ?? 0,
    openingBalance: d?.opening_balance ?? 0,
    hasMigrationJE: d?.has_migration_je ?? false,
    drift: d?.drift ?? 0,
    hasDrift: d?.has_drift ?? false,
    // Only "loading" on the very first fetch — refetches keep previous data,
    // so the card does NOT flash a skeleton or a wrong verdict on reload.
    isLoading: query.isLoading && !d,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}
