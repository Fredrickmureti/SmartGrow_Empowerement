/**
 * Depreciation Report Page
 * 
 * Shows fixed asset depreciation schedules with cost, accumulated depreciation,
 * and net book value. Rendered by the canonical reporting engine
 * (`@/design-system/reports`).
 */

import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2, TrendingDown, DollarSign } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { useBranch } from "@/contexts/BranchContext";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { format, endOfMonth, startOfYear } from "date-fns";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import {
  ReportSurface,
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
/**
 * This is a base-currency report: cost and residual value are the
 * server-stamped base amounts (`base_purchase_price` / `base_residual_value`),
 * which is also the basis depreciation and the GL use. The transaction
 * currency is carried for provenance only and never summed.
 */
interface AssetDepreciation {
  id: string;
  asset_number: string;
  name: string;
  category_name: string;
  purchase_date: string;
  /** Base-currency acquisition cost. */
  purchase_price: number;
  /** Base-currency residual value. */
  residual_value: number;
  currency: string;
  acquisition_exchange_rate: number | null;
  depreciation_method: string;
  useful_life_years: number;
  accumulated_depreciation: number;
  book_value: number;
  status: string;
}

function DepreciationReportInner() {
  const now = new Date();
  const [dateTo, setDateTo] = useState(format(endOfMonth(now), "yyyy-MM-dd"));
  const [drillDown, setDrillDown] = useState<DrillDownConfig | null>(null);

  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { filters } = useReportFilters();
  const { branches } = useBranch();
  const branchId = filters.branchId;
  const branchLabel = branchId
    ? (branches.find((b) => b.id === branchId)?.name || "Branch")
    : "All branches consolidated";

  const { data: assets, isLoading, error } = useQuery({
    queryKey: ["depreciation-report", currentOrg?.id, currentBusiness?.id, branchId, dateTo],
    queryFn: async (): Promise<AssetDepreciation[]> => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      let q = supabase
        .from("fixed_assets")
        .select(`
          id, asset_number, name, purchase_date,
          purchase_price, residual_value, currency, acquisition_exchange_rate,
          base_purchase_price, base_residual_value,
          depreciation_method, useful_life_years, accumulated_depreciation,
          book_value, status, branch_id,
          asset_categories(name)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("asset_number");
      if (branchId) {
        q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      }
      const { data: fixedAssets, error: assetsError } = await q;

      if (assetsError) throw assetsError;

      return (fixedAssets || []).map((a: any) => ({
        id: a.id,
        asset_number: a.asset_number || "",
        name: a.name,
        category_name: a.asset_categories?.name || "Uncategorized",
        purchase_date: a.purchase_date,
        purchase_price: a.purchase_price || 0,
        residual_value: a.residual_value || 0,
        depreciation_method: a.depreciation_method || "straight_line",
        useful_life_years: a.useful_life_years || 0,
        accumulated_depreciation: a.accumulated_depreciation || 0,
        book_value: a.book_value || 0,
        status: a.status || "active",
      }));
    },
    enabled: !!currentOrg?.id,
  });

  const totalCost = assets?.reduce((s, a) => s + a.purchase_price, 0) || 0;
  const totalAccDep = assets?.reduce((s, a) => s + a.accumulated_depreciation, 0) || 0;
  const totalNBV = assets?.reduce((s, a) => s + a.book_value, 0) || 0;

  const methodLabel = (m: string) => {
    const map: Record<string, string> = {
      straight_line: "Straight Line",
      declining_balance: "Declining Balance",
      double_declining: "Double Declining",
      sum_of_years: "Sum of Years",
    };
    return map[m] || m;
  };

  // ── One column + row declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "code", header: "Code", width: "w-[100px]", sticky: true },
      { key: "name", header: "Asset", width: "w-[220px]", sticky: true, groupEnd: true },
      { key: "category", header: "Category", width: "w-[140px]" },
      { key: "date", header: "Acquired", format: "date", width: "w-[110px]" },
      { key: "cost", header: "Cost", format: "currency", width: "w-[130px]" },
      { key: "method", header: "Method", width: "w-[150px]" },
      { key: "life", header: "Life", format: "number", width: "w-[80px]" },
      { key: "acc_dep", header: "Accum. Dep.", format: "currency", width: "w-[130px]" },
      { key: "nbv", header: "Net Book Value", format: "currency", width: "w-[140px]" },
      {
        key: "status",
        header: "Status",
        align: "center",
        width: "w-[100px]",
        render: (row) => {
          const r = row as unknown as ReportRow;
          const status = String(r.values?.status ?? "");
          if (!status) return null;
          return (
            <Badge variant={status === "active" ? "default" : "secondary"} className="text-xs">
              {status}
            </Badge>
          );
        },
      },
    ],
    [],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const list = assets || [];
    const out: ReportRow[] = list.map((asset) => ({
      id: asset.id,
      onClick: () => setDrillDown({
        title: `Depreciation — ${asset.name}`,
        accountType: "depreciation_expense",
        startDate: format(startOfYear(new Date(dateTo)), "yyyy-MM-dd"),
        endDate: dateTo,
        sourceType: "depreciation",
      }),
      values: {
        code: asset.asset_number,
        name: asset.name,
        category: asset.category_name,
        date: asset.purchase_date,
        cost: asset.purchase_price,
        method: methodLabel(asset.depreciation_method),
        life: asset.useful_life_years,
        acc_dep: asset.accumulated_depreciation,
        nbv: asset.book_value,
        status: asset.status,
      },
    }));

    if (out.length > 0) {
      out.push({
        id: "grand-total",
        kind: "grandTotal",
        label: "TOTAL",
        values: { cost: totalCost, acc_dep: totalAccDep, nbv: totalNBV },
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, dateTo, totalCost, totalAccDep, totalNBV]);

  const getExportConfig = useCallback((): ExportConfig => ({
    title: "Depreciation Report",
    reportType: "depreciation_schedule",
    companyName: currentOrg?.name || "",
    dateRange: `As of ${format(new Date(dateTo), "MMMM d, yyyy")} · ${branchLabel}`,
    columns: toExportColumns(columns),
    rows: toExportRows(rows, columns),
    sheetName: "Depreciation",
    currency: baseCurrency,
  }), [columns, rows, dateTo, currentOrg, baseCurrency, branchLabel]);

  return (
    <ReportPageLayout
      title="Depreciation Report"
      description={`Fixed asset depreciation schedule and net book values · ${branchLabel}`}
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!assets || assets.length === 0}
      emptyState={{
        kind: "missing_prerequisite",
        title: "No fixed assets in scope",
        message:
          "Depreciation is derived from registered fixed assets. Register assets and their depreciation schedules before this report can produce figures.",
      }}
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['depreciation-report'] as const]} tooltip="Refresh depreciation report" />
          <SaveViewButton
            reportType="depreciation"
            currentFilters={{ dateTo }}
            onLoadView={(filters) => {
              if (filters.dateTo) setDateTo(filters.dateTo);
            }}
          />
        </>
      }
      filters={
        <ReportFilters dateMode="asof" dateTo={dateTo} onDateToChange={setDateTo}>
          <ReportBranchFilter reportKind="depreciation" />
        </ReportFilters>
      }
    >
      <div className="space-y-6">
        {/* KPI Cards */}
        <div className="stats-grid">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Asset Cost</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(totalCost, baseCurrency)}</div>
              <p className="text-xs text-muted-foreground">{assets?.length || 0} assets</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Accum. Depreciation</CardTitle>
              <TrendingDown className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{formatCurrency(totalAccDep, baseCurrency)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net Book Value</CardTitle>
              <DollarSign className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{formatCurrency(totalNBV, baseCurrency)}</div>
            </CardContent>
          </Card>
        </div>

        {/* Asset schedule, rendered by the shared reporting engine */}
        <ReportSurface
          title="Depreciation Report"
          asOfDate={`As of ${format(new Date(dateTo), "MMMM d, yyyy")}`}
          subtitle={branchLabel}
          profile="operational"
        >
          <ReportTable
            columns={columns}
            rows={rows}
            currency={baseCurrency}
            caption="Asset depreciation schedule"
            emptyMessage="No fixed assets found"
          />
        </ReportSurface>
      </div>

      <DrillDownDialog
        open={!!drillDown}
        onOpenChange={(open) => !open && setDrillDown(null)}
        config={drillDown}
      />
    </ReportPageLayout>
  );
}


export default function DepreciationReport() {
  return (
    
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Depreciation report">
      <DepreciationReportInner />
    </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
