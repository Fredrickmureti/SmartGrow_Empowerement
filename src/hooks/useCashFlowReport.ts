/**
 * Cash Flow Report Hook (GL-based, Indirect Method)
 * 
 * Generates a proper cash flow statement using journal entries:
 * - Operating: Net income + adjustments for non-cash items
 * - Investing: Fixed asset purchases/sales from asset accounts
 * - Financing: Loan proceeds/repayments, equity changes
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

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
  openingCash: number;
  closingCash: number;
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
   * When set, the underlying `get_account_movements` RPC narrows
   * journal-entry aggregation to that branch (and company-wide entries).
   */
  branchId?: string | null;
}

export function useCashFlowReport(params: UseCashFlowParams) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["cash-flow-report", currentOrg?.id, currentBusiness?.id, params.branchId ?? "all", params.dateFrom, params.dateTo],
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

      // Fetch all accounts with their types, codes, and detail_type for fallback classification
      let accountsQuery = supabase
        .from("accounts")
        .select("id, code, name, account_type, detail_type, opening_balance, cash_flow_category")
        .eq("organization_id", orgId)
        .eq("is_active", true);

      if (businessId) {
        accountsQuery = accountsQuery.or(`business_id.eq.${businessId},business_id.is.null`);
      }

      const { data: accounts, error: accErr } = await accountsQuery;
      if (accErr) throw accErr;

      // Fetch period movements and prior movements via RPC in parallel
      // Pass _business_id and _branch_id so the cash flow narrows to the
      // active scope. _branch_id NULL = company-wide / consolidated.
      const [periodResult, priorResult] = await Promise.all([
        supabase.rpc("get_account_movements", {
          _org_id: orgId,
          _date_from: params.dateFrom,
          _date_to: params.dateTo,
          _business_id: businessId || null,
          _branch_id: params.branchId ?? null,
        }),
        supabase.rpc("get_account_movements", {
          _org_id: orgId,
          _date_from: "1900-01-01",
          _date_to: new Date(new Date(params.dateFrom).getTime() - 86400000).toISOString().split("T")[0],
          _business_id: businessId || null,
          _branch_id: params.branchId ?? null,
        }),
      ]);

      if (periodResult.error) throw periodResult.error;
      if (priorResult.error) throw priorResult.error;

      // Convert RPC results to maps
      const periodByAcct = rpcToMap(periodResult.data || []);
      const priorByAcct = rpcToMap(priorResult.data || []);

      // Classify accounts using DB-driven cash_flow_category (Odoo-style)
      const accountMap = new Map(accounts?.map(a => [a.id, a]) || []);

      // Helper to sum net movement for a set of account IDs
      const netMovement = (ids: string[], type: string) => {
        let total = 0;
        for (const id of ids) {
          const mov = periodByAcct.get(id);
          if (!mov) continue;
          if (["asset", "expense"].includes(type)) {
            total += mov.debit - mov.credit;
          } else {
            total += mov.credit - mov.debit;
          }
        }
        return total;
      };

      // Categorize accounts by cash_flow_category column
      const cashAccounts: string[] = [];
      const receivableAccounts: string[] = [];
      const payableAccounts: string[] = [];
      const inventoryAccounts: string[] = [];
      const fixedAssetAccounts: string[] = [];
      const depreciationAccounts: string[] = [];
      const loanAccounts: string[] = [];
      const equityAccounts: string[] = [];
      const incomeAccounts: string[] = [];
      const expenseAccounts: string[] = [];
      const otherCurrentAssets: string[] = [];
      const otherCurrentLiabilities: string[] = [];

      for (const acct of accounts || []) {
        const category = (acct as any).cash_flow_category as string | null;

        switch (category) {
          case "cash":
            cashAccounts.push(acct.id);
            break;
          case "operating_receivable":
            receivableAccounts.push(acct.id);
            break;
          case "operating_payable":
            payableAccounts.push(acct.id);
            break;
          case "operating_inventory":
            inventoryAccounts.push(acct.id);
            break;
          case "investing_fixed_asset":
            fixedAssetAccounts.push(acct.id);
            break;
          case "investing_depreciation":
            depreciationAccounts.push(acct.id);
            break;
          case "financing_loan":
            loanAccounts.push(acct.id);
            break;
          case "financing_equity":
            equityAccounts.push(acct.id);
            break;
          case "operating_income":
            incomeAccounts.push(acct.id);
            break;
          case "operating_expense":
            expenseAccounts.push(acct.id);
            break;
          case "operating_other_current_asset":
            otherCurrentAssets.push(acct.id);
            break;
          case "operating_other_current_liability":
            otherCurrentLiabilities.push(acct.id);
            break;
          default: {
            // M3 FIX: Use detail_type for smarter fallback classification
            // instead of dumping all assets→current and all liabilities→current
            const detailType = (acct as any).detail_type as string | null;
            if (acct.account_type === "income") {
              incomeAccounts.push(acct.id);
            } else if (acct.account_type === "expense") {
              expenseAccounts.push(acct.id);
            } else if (acct.account_type === "equity") {
              equityAccounts.push(acct.id);
            } else if (acct.account_type === "asset") {
              // Check detail_type to distinguish fixed assets from current assets
              const fixedAssetDetailTypes = [
                "accumulated_depreciation", "accumulated_depletion", "buildings",
                "depletable_assets", "fixed_asset_computers", "fixed_asset_copiers",
                "fixed_asset_furniture", "fixed_asset_phone", "fixed_asset_photo_video",
                "fixed_asset_software", "fixed_asset_other_tools", "furniture_fixtures",
                "intangible_assets", "land", "leasehold_improvements",
                "machinery_equipment", "other_fixed_asset", "vehicles",
              ];
              if (detailType && fixedAssetDetailTypes.includes(detailType)) {
                fixedAssetAccounts.push(acct.id);
              } else {
                otherCurrentAssets.push(acct.id);
              }
            } else if (acct.account_type === "liability") {
              // Check detail_type to distinguish long-term liabilities
              const longTermLiabilityDetailTypes = [
                "long_term_debt", "notes_payable_non_current",
                "shareholders_notes_payable", "other_long_term_liabilities",
              ];
              if (detailType && longTermLiabilityDetailTypes.includes(detailType)) {
                loanAccounts.push(acct.id);
              } else {
                otherCurrentLiabilities.push(acct.id);
              }
            }
            break;
          }
        }
      }

      // --- OPERATING (Indirect Method) ---
      // Net Income
      let netIncome = 0;
      for (const id of incomeAccounts) {
        const mov = periodByAcct.get(id);
        if (mov) netIncome += mov.credit - mov.debit;
      }
      for (const id of expenseAccounts) {
        const mov = periodByAcct.get(id);
        if (mov) netIncome -= mov.debit - mov.credit;
      }

      // Depreciation add-back (non-cash expense)
      const depreciation = Math.abs(netMovement(depreciationAccounts, "asset"));

      // Working capital changes
      const arChange = -netMovement(receivableAccounts, "asset");
      const inventoryChange = -netMovement(inventoryAccounts, "asset");
      const apChange = netMovement(payableAccounts, "liability");
      const otherCAChange = -netMovement(otherCurrentAssets, "asset");
      const otherCLChange = netMovement(otherCurrentLiabilities, "liability");

      const operatingTotal = netIncome + depreciation + arChange + inventoryChange + apChange + otherCAChange + otherCLChange;

      const operating: CashFlowSection = {
        label: "Cash Flows from Operating Activities",
        items: [
          { label: "Net Income", amount: netIncome },
          { label: "Depreciation & Amortization", amount: depreciation },
          { label: "Change in Accounts Receivable", amount: arChange },
          { label: "Change in Inventory", amount: inventoryChange },
          { label: "Change in Accounts Payable", amount: apChange },
          ...(otherCAChange !== 0 ? [{ label: "Change in Other Current Assets", amount: otherCAChange }] : []),
          ...(otherCLChange !== 0 ? [{ label: "Change in Other Current Liabilities", amount: otherCLChange }] : []),
        ].filter(i => Math.abs(i.amount) >= 0.01),
        total: operatingTotal,
      };

      // --- INVESTING ---
      const assetPurchases = netMovement(fixedAssetAccounts, "asset");

      const investing: CashFlowSection = {
        label: "Cash Flows from Investing Activities",
        items: [
          ...(assetPurchases !== 0 ? [{ label: "Purchase/Sale of Fixed Assets", amount: -assetPurchases }] : []),
        ],
        total: -assetPurchases,
      };

      // --- FINANCING ---
      const loanChange = netMovement(loanAccounts, "liability");
      const equityChange = netMovement(equityAccounts, "equity");

      const financing: CashFlowSection = {
        label: "Cash Flows from Financing Activities",
        items: [
          ...(loanChange !== 0 ? [{ label: "Net Borrowings / Repayments", amount: loanChange }] : []),
          ...(equityChange !== 0 ? [{ label: "Equity Changes", amount: equityChange }] : []),
        ],
        total: loanChange + equityChange,
      };

      const netCashFlow = operatingTotal + investing.total + financing.total;

      // Calculate opening cash balance
      let openingCash = 0;
      for (const id of cashAccounts) {
        const acct: any = accountMap.get(id);
        const prior = priorByAcct.get(id) || { debit: 0, credit: 0 };
        openingCash += (acct?.opening_balance || 0) + prior.debit - prior.credit;
      }

      return {
        dateRange: { from: params.dateFrom, to: params.dateTo },
        operating,
        investing,
        financing,
        netCashFlow,
        openingCash,
        closingCash: openingCash + netCashFlow,
      };
    },
    enabled: !!currentOrg?.id,
    staleTime: 5 * 60 * 1000,
  });
}

function rpcToMap(rows: any[]): Map<string, { debit: number; credit: number }> {
  const map = new Map<string, { debit: number; credit: number }>();
  for (const r of rows) {
    map.set(r.account_id, {
      debit: Number(r.total_debit) || 0,
      credit: Number(r.total_credit) || 0,
    });
  }
  return map;
}

function emptyCashFlow(params: UseCashFlowParams): CashFlowReportData {
  const emptySection: CashFlowSection = { label: "", items: [], total: 0 };
  return {
    dateRange: { from: params.dateFrom, to: params.dateTo },
    operating: { ...emptySection, label: "Cash Flows from Operating Activities" },
    investing: { ...emptySection, label: "Cash Flows from Investing Activities" },
    financing: { ...emptySection, label: "Cash Flows from Financing Activities" },
    netCashFlow: 0,
    openingCash: 0,
    closingCash: 0,
  };
}
