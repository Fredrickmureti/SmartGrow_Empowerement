/**
 * Depreciation Report Page
 * 
 * Shows fixed asset depreciation schedules with cost, accumulated depreciation,
 * and net book value.
 */

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";
import { cn } from "@/lib/utils";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
interface AssetDepreciation {
  id: string;
  asset_number: string;
  name: string;
  category_name: string;
  purchase_date: string;
  purchase_price: number;
  residual_value: number;
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
          id, asset_number, name, purchase_date, purchase_price, residual_value,
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

  const getExportConfig = useCallback((): ExportConfig => {
    const rows: ExportRow[] = (assets || []).map((a) => ({
      code: a.asset_number, name: a.name, category: a.category_name,
      date: a.purchase_date, cost: a.purchase_price,
      method: methodLabel(a.depreciation_method), life: a.useful_life_years,
      acc_dep: a.accumulated_depreciation, nbv: a.book_value, status: a.status,
    }));
    rows.push({
      code: "", name: "TOTAL", category: "", date: "", cost: totalCost,
      method: "", life: null, acc_dep: totalAccDep, nbv: totalNBV, status: "",
      _isGrandTotal: true,
    });
    return {
      title: "Depreciation Report",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `As of ${format(new Date(dateTo), "MMMM d, yyyy")} · ${branchLabel}`,
      columns: [
        { key: "code", header: "Asset Code", width: 12 },
        { key: "name", header: "Asset Name", width: 22 },
        { key: "category", header: "Category", width: 14 },
        { key: "date", header: "Acquired", width: 12 },
        { key: "cost", header: "Cost", width: 14, format: "currency", align: "right" },
        { key: "method", header: "Method", width: 14 },
        { key: "life", header: "Life (Yrs)", width: 8, align: "right" },
        { key: "acc_dep", header: "Accum. Dep.", width: 14, format: "currency", align: "right" },
        { key: "nbv", header: "Net Book Value", width: 14, format: "currency", align: "right" },
      ],
      rows,
      sheetName: "Depreciation",
      currency: baseCurrency,
    };
  }, [assets, totalCost, totalAccDep, totalNBV, dateTo, currentOrg, baseCurrency, branchLabel]);

  return (
    <ReportPageLayout
      title="Depreciation Report"
      description={`Fixed asset depreciation schedule and net book values · ${branchLabel}`}
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!assets || assets.length === 0}
      emptyMessage="No fixed assets found"
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

        {/* Asset Table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Asset Depreciation Schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Asset</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Acquired</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Life</TableHead>
                  <TableHead className="text-right">Accum. Dep.</TableHead>
                  <TableHead className="text-right">Net Book Value</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets?.map((asset) => (
                  <TableRow key={asset.id}>
                    <TableCell className="font-mono text-sm text-muted-foreground">{asset.asset_number}</TableCell>
                    <TableCell className="font-medium">{asset.name}</TableCell>
                    <TableCell className="text-sm">{asset.category_name}</TableCell>
                    <TableCell className="text-sm">{asset.purchase_date ? format(new Date(asset.purchase_date), "MMM d, yyyy") : "—"}</TableCell>
                    <TableCell className="text-right">{formatCurrency(asset.purchase_price, baseCurrency)}</TableCell>
                    <TableCell className="text-sm">{methodLabel(asset.depreciation_method)}</TableCell>
                    <TableCell className="text-right">{asset.useful_life_years} yrs</TableCell>
                    <TableCell
                      className="text-right text-destructive cursor-pointer hover:underline"
                      onClick={() => setDrillDown({
                        title: `Depreciation — ${asset.name}`,
                        accountType: "depreciation_expense",
                        startDate: format(startOfYear(new Date(dateTo)), "yyyy-MM-dd"),
                        endDate: dateTo,
                        sourceType: "depreciation",
                      })}
                    >
                      {formatCurrency(asset.accumulated_depreciation, baseCurrency)}
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(asset.book_value, baseCurrency)}</TableCell>
                    <TableCell className="text-center">
                      <Badge variant={asset.status === "active" ? "default" : "secondary"} className="text-xs">
                        {asset.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {/* Grand Total */}
                <TableRow className="font-bold bg-muted border-t-2">
                  <TableCell />
                  <TableCell>TOTAL</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right">{formatCurrency(totalCost, baseCurrency)}</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right text-destructive">{formatCurrency(totalAccDep, baseCurrency)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(totalNBV, baseCurrency)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
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
