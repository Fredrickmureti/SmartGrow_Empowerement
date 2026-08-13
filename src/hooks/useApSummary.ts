import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

/**
 * Canonical Accounts Payable summary.
 *
 * The ONLY approved source of AP outstanding/overdue/aging figures in the UI.
 * It reads `get_ap_summary`, which aggregates the `finance_ap_open_items_as_of`
 * projection (posted AP documents net of allocations, credit notes and
 * advances) — never `bills.total - bills.amount_paid` client-side, which
 * ignores credit notes, advances, multi-currency and unposted drafts.
 *
 * Pre-posting review states (draft / submitted / approved) carry no GL effect
 * and are therefore excluded from every figure below.
 */
export interface ApSummary {
  /** Count of open (residual > 0) posted AP documents. */
  openDocumentCount: number;
  /** Total residual outstanding, company base currency. */
  totalOutstanding: number;
  /** Residual not yet due. */
  notDue: number;
  /** Aging buckets by days past due. */
  days0to30: number;
  days31to60: number;
  days61to90: number;
  days90Plus: number;
  /** Documents past their due date. */
  overdueCount: number;
  /** Total overdue residual (all past-due buckets). */
  totalOverdue: number;
  /** Posted-state bills with no posted journal entry — an integrity signal. */
  unpostedDocumentCount: number;
  unpostedAmount: number;
}

const EMPTY: ApSummary = {
  openDocumentCount: 0,
  totalOutstanding: 0,
  notDue: 0,
  days0to30: 0,
  days31to60: 0,
  days61to90: 0,
  days90Plus: 0,
  overdueCount: 0,
  totalOverdue: 0,
  unpostedDocumentCount: 0,
  unpostedAmount: 0,
};

export function useApSummary(asOf?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const [summary, setSummary] = useState<ApSummary>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setSummary(EMPTY);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc("get_ap_summary", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness.id,
        _branch_id: currentBranch?.id ?? null,
        ...(asOf ? { _as_of: asOf } : {}),
      } as any);
      if (rpcError) throw rpcError;

      const row = (Array.isArray(data) ? data[0] : data) as any;
      if (!row) {
        setSummary(EMPTY);
        return;
      }
      const n = (v: unknown) => Number(v ?? 0);
      const current = n(row.current_bucket);
      const d30 = n(row.days30);
      const d60 = n(row.days60);
      const d90 = n(row.days90);
      setSummary({
        openDocumentCount: n(row.open_document_count),
        totalOutstanding: n(row.total_residual),
        notDue: n(row.not_due),
        days0to30: current,
        days31to60: d30,
        days61to90: d60,
        days90Plus: d90,
        overdueCount: n(row.overdue_count),
        totalOverdue: current + d30 + d60 + d90,
        unpostedDocumentCount: n(row.unposted_document_count),
        unpostedAmount: n(row.unposted_amount),
      });
    } catch (e: any) {
      console.error("Error loading AP summary:", e);
      setError(e?.message ?? "Failed to load AP summary");
      setSummary(EMPTY);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id, asOf]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  return { summary, isLoading, error, refresh: fetchSummary };
}
