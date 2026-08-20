/**
 * Cash Flow Report Hook — thin seam over the server-owned engine.
 *
 * The statement itself (classification, opening/closing cash, FX effect and
 * the reconciliation residual) is computed by `finance_cash_flow_statement`
 * in SQL. This hook only:
 *   - resolves org / company / branch scope,
 *   - enforces the consolidation gate,
 *   - reshapes the payload for the page.
 *
 * No accounting arithmetic lives here. Anything that looks like a rule
 * (what is cash, what is financing, what closing cash equals) belongs in
 * the engine, where every caller sees the same answer.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import {
  fetchCashFlowStatement,
  type CashFlowAccountBalance,
  type CashFlowReconciliation,
  type CashFlowUnclassifiedAccount,
} from "@/services/finance/cashFlow";

export interface CashFlowSection {
  label: string;
  items: { label: string; amount: number; accountIds?: string[] }[];
  total: number;
}

export interface CashFlowReportData {
  dateRange: { from: string; to: string };
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netCashFlow: number;
  /** FX (gain)/loss on cash held — IAS 7 separate line, outside operating. */
  fxEffect: number;
  openingCash: number;
  /** Derived independently from ledger balances, not `opening + movement`. */
  closingCash: number;
  /** Built-up statement vs derived closing cash. Residual ≠ 0 is a finding. */
  reconciliation: CashFlowReconciliation;
  cashAccounts: CashFlowAccountBalance[];
  /** Active accounts that fell back to a default bucket — classify these. */
  needsClassification: CashFlowUnclassifiedAccount[];
  /**
   * True when no company is in context for an org with >1 company.
   * Cross-company cash flow aggregation is intentionally blocked —
   * see /reports/consolidation. Callers MUST surface a "select a
   * company" message instead of summing non-consolidated ledgers.
   */
  requiresConsolidation?: boolean;
}

interface UseCashFlowParams {
  dateFrom: string;
  dateTo: string;
  /**
   * Optional branch filter (typically `filters.branchId` from
   * `ReportFilterContext`). NULL = company-wide / consolidated view.
   */
  branchId?: string | null;
}

export function useCashFlowReport(params: UseCashFlowParams) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: [
      "cash-flow-report",
      currentOrg?.id,
      currentBusiness?.id,
      params.branchId ?? "all",
      params.dateFrom,
      params.dateTo,
    ],
    queryFn: async (): Promise<CashFlowReportData> => {
      if (!currentOrg?.id) {
        return emptyCashFlow(params);
      }

      const orgId = currentOrg.id;
      const businessId = currentBusiness?.id;

      // Consolidation gate: refuse to render a single-company cash flow when
      // the workspace actually has more than one company and none is selected.
      // Summing non-consolidated ledgers without intercompany eliminations
      // produces materially wrong financials.
      if (!businessId) {
        const { count } = await supabase
          // SCOPE-EXEMPT: "businesses" is workspace-wide (not in BUSINESS_SCOPED_TABLES)
          .from("businesses")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("is_active", true);
        if ((count ?? 0) > 1) {
          return { ...emptyCashFlow(params), requiresConsolidation: true };
        }
      }

      const statement = await fetchCashFlowStatement({
        orgId,
        businessId: businessId ?? null,
        branchId: params.branchId ?? null,
        from: params.dateFrom,
        to: params.dateTo,
      });

      return {
        dateRange: { from: statement.from, to: statement.to },
        operating: toSection(statement.operating),
        investing: toSection(statement.investing),
        financing: toSection(statement.financing),
        netCashFlow: statement.netCashFlow,
        fxEffect: statement.fxEffect,
        openingCash: statement.openingCash,
        closingCash: statement.closingCash,
        reconciliation: statement.reconciliation,
        cashAccounts: statement.cashAccounts,
        needsClassification: statement.needsClassification,
      };
    },
    enabled: !!currentOrg?.id,
    staleTime: 5 * 60 * 1000,
  });
}

function toSection(section: {
  label: string;
  total: number;
  items: { label: string; amount: number }[];
}): CashFlowSection {
  return {
    label: section.label,
    total: section.total,
    items: section.items.map((item) => ({ label: item.label, amount: item.amount })),
  };
}

function emptyCashFlow(params: UseCashFlowParams): CashFlowReportData {
  const zeroRecon: CashFlowReconciliation = {
    openingCash: 0,
    netCashFlow: 0,
    fxEffect: 0,
    expectedClosingCash: 0,
    derivedClosingCash: 0,
    residual: 0,
    inBalance: true,
  };
  return {
    dateRange: { from: params.dateFrom, to: params.dateTo },
    operating: { label: "Cash flows from operating activities", items: [], total: 0 },
    investing: { label: "Cash flows from investing activities", items: [], total: 0 },
    financing: { label: "Cash flows from financing activities", items: [], total: 0 },
    netCashFlow: 0,
    fxEffect: 0,
    openingCash: 0,
    closingCash: 0,
    reconciliation: zeroRecon,
    cashAccounts: [],
    needsClassification: [],
  };
}
