/**
 * Cash Flow Statement Page (GL-based, Indirect Method)
 * 
 * Proper cash flow statement derived from journal entries showing:
 * - Operating activities via indirect method (net income + adjustments)
 * - Investing activities (fixed asset changes)
 * - Financing activities (loans + equity)
 * - Opening/closing cash reconciliation
 */

import { useState, useCallback, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Building2, TrendingUp, CreditCard, ArrowUpRight, ArrowDownRight, Banknote, Wallet } from "lucide-react";
import { format, startOfYear, endOfMonth } from "date-fns";
import { useCashFlowReport, type CashFlowSection } from "@/hooks/useCashFlowReport";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import type { ExportConfig, ExportColumn, ExportRow } from "@/services/reports/ReportExportService";
import { cn } from "@/lib/utils";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
function CashFlowReportInner() {
  const now = new Date();
  const { filters, setDateFrom: setSharedDateFrom, setDateTo: setSharedDateTo } = useReportFilters();
  const [dateFrom, setDateFrom] = useState(filters.dateFrom);
  const [dateTo, setDateTo] = useState(filters.dateTo);
  const [drillDown, setDrillDown] = useState<DrillDownConfig | null>(null);

  useEffect(() => { setSharedDateFrom(dateFrom); }, [dateFrom]);
  useEffect(() => { setSharedDateTo(dateTo); }, [dateTo]);

  const { formatCurrency, baseCurrency, isReady } = useCurrency();
  const { currentOrg } = useOrganization();

  const { data, isLoading, error } = useCashFlowReport({ dateFrom, dateTo, branchId: filters.branchId });

  const fmt = (amount: number) => formatCurrency(amount, baseCurrency);

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "item", header: "Item", width: 40 },
      { key: "amount", header: "Amount", width: 20, format: "currency", align: "right" },
    ];

    const rows: ExportRow[] = [];
    if (data) {
      for (const section of [data.operating, data.investing, data.financing]) {
        rows.push({ item: section.label, amount: null, _isHeader: true });
        // For operating section, add "Adjustments for non-cash items:" sub-header
        // after the first item (Net Income) per accounting convention
        if (section === data.operating && section.items.length > 1) {
          rows.push({ item: section.items[0].label, amount: section.items[0].amount, _depth: 1 });
          rows.push({ item: "Adjustments for non-cash items:", amount: null, _depth: 1 });
          for (let i = 1; i < section.items.length; i++) {
            rows.push({ item: section.items[i].label, amount: section.items[i].amount, _depth: 2 });
          }
        } else {
          for (const item of section.items) {
            rows.push({ item: item.label, amount: item.amount, _depth: 1 });
          }
        }
        rows.push({ item: `Net ${section.label.replace("Cash Flows from ", "")}`, amount: section.total, _isSubtotal: true });
        rows.push({ item: "", amount: null });
      }
      rows.push({ item: "Net Increase/(Decrease) in Cash", amount: data.netCashFlow, _isGrandTotal: true });
      rows.push({ item: "Opening Cash Balance", amount: data.openingCash });
      rows.push({ item: "Closing Cash Balance", amount: data.closingCash, _isGrandTotal: true });
    }

    return {
      title: "Cash Flow Statement",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns,
      rows,
      sheetName: "Cash Flow",
      currency: baseCurrency,
    };
  }, [data, dateFrom, dateTo, currentOrg, baseCurrency]);

  const renderSection = (section: CashFlowSection, icon: React.ReactNode, iconColor: string) => (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-base">{section.label}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {section.items.length === 0 ? (
          <p className="text-sm text-muted-foreground italic py-2">
            No activity recorded for this period
          </p>
        ) : (
          section.items.map((item, i) => (
            <div
              key={i}
              className={cn(
                "flex justify-between py-1.5 pl-4",
                item.accountIds?.length ? "cursor-pointer hover:bg-accent/50 rounded-md transition-colors" : ""
              )}
              onClick={() => {
                if (item.accountIds?.length) {
                  setDrillDown({
                    title: item.label,
                    accountId: item.accountIds[0],
                    startDate: dateFrom,
                    endDate: dateTo,
                  });
                }
              }}
            >
              <span className="text-sm text-muted-foreground">{item.label}</span>
              <span className={cn("text-sm font-medium", item.amount < 0 ? "text-destructive" : "text-foreground")}>
                {item.amount < 0 ? `(${fmt(Math.abs(item.amount))})` : fmt(item.amount)}
              </span>
            </div>
          ))
        )}
        <Separator className="my-2" />
        <div className="flex justify-between py-2">
          <span className="font-semibold text-sm">
            Net {section.label.replace("Cash Flows from ", "")}
          </span>
          <span className={cn("font-semibold", section.total >= 0 ? "text-success" : "text-destructive")}>
            {fmt(section.total)}
          </span>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <ReportPageLayout
      title="Cash Flow Statement"
      description="Indirect method — derived from journal entries"
      isLoading={isLoading || !isReady}
      error={error as Error | null}
      isEmpty={!data}
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['cash-flow-report'] as const]} tooltip="Refresh cash flow" />
          <SaveViewButton
            reportType="cash-flow"
            currentFilters={{ dateFrom, dateTo }}
            onLoadView={(filters) => {
              if (filters.dateFrom) setDateFrom(filters.dateFrom);
              if (filters.dateTo) setDateTo(filters.dateTo);
            }}
          />
        </>
      }
      filters={
        <ReportFilters
          dateMode="range"
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
        >
          <ReportBranchFilter reportKind="cash_flow" />
        </ReportFilters>
      }
    >
      {data && (
        <div className="space-y-6">
          {/* KPI Cards */}
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <span className="text-sm font-medium">Opening Cash</span>
                <Wallet className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{fmt(data.openingCash)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <span className="text-sm font-medium">Operating</span>
                <Building2 className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className={cn("text-2xl font-bold", data.operating.total >= 0 ? "text-success" : "text-destructive")}>
                  {fmt(data.operating.total)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <span className="text-sm font-medium">Net Cash Flow</span>
                {data.netCashFlow >= 0 ? (
                  <ArrowUpRight className="h-4 w-4 text-success" />
                ) : (
                  <ArrowDownRight className="h-4 w-4 text-destructive" />
                )}
              </CardHeader>
              <CardContent>
                <div className={cn("text-2xl font-bold", data.netCashFlow >= 0 ? "text-success" : "text-destructive")}>
                  {fmt(data.netCashFlow)}
                </div>
              </CardContent>
            </Card>
            <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <span className="text-sm font-medium">Closing Cash</span>
                <Banknote className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary">{fmt(data.closingCash)}</div>
              </CardContent>
            </Card>
          </div>

          {/* Sections */}
          {renderSection(data.operating, <Building2 className="h-4 w-4 text-primary" />, "text-primary")}
          {renderSection(data.investing, <TrendingUp className="h-4 w-4 text-chart-4" />, "text-chart-4")}
          {renderSection(data.financing, <CreditCard className="h-4 w-4 text-chart-5" />, "text-chart-5")}

          {/* Net Cash Summary */}
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-6">
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="font-semibold">Net Increase/(Decrease) in Cash</span>
                  <span className={cn("text-xl font-bold", data.netCashFlow >= 0 ? "text-success" : "text-destructive")}>
                    {fmt(data.netCashFlow)}
                  </span>
                </div>
                <Separator />
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Opening Cash Balance</span>
                  <span className="font-medium">{fmt(data.openingCash)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="font-bold text-lg">Closing Cash Balance</span>
                  <span className="font-bold text-lg text-primary">{fmt(data.closingCash)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* M5 FIX: Universal drill-down support */}
      <DrillDownDialog
        open={!!drillDown}
        onOpenChange={(open) => !open && setDrillDown(null)}
        config={drillDown}
      />
    </ReportPageLayout>
  );
}


export default function CashFlowReport() {
  return (
    
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Cash Flow">
      <CashFlowReportInner />
    </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
