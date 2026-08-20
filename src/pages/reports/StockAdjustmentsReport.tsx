/**
 * Stock Adjustments Report — Phase B5, server-owned since Phase 8.
 *
 * Read-only observation of the inventory adjustment workflow; the workflow
 * itself remains the only write path.
 *
 * ACCOUNTING OWNERSHIP. Every figure on this page is produced by
 * `report_stock_adjustments`. The browser used to sum
 * `quantity_adjustment × unit_cost` from the line snapshots, which meant the
 * "cost impact" of a posted adjustment could disagree with what actually hit
 * the ledger. The RPC now reads the immutable movement ledger for anything
 * that posted, and flags the remainder as an ESTIMATE via `cost_basis` — an
 * unposted intent figure must never read as a posted amount.
 *
 * Scope: org + company are mandatory (the RPC refuses a null company, so the
 * page cannot silently widen to the whole organization); branch comes from
 * `useFinanceScope` (kind `stock_adjustment` is branch-sliceable per
 * `branchScopability.ts`).
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ReportSurface,
  ReportTable,
  formatAccountingNumber,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import {
  useStockAdjustmentsReport,
  type StockAdjustmentReportRow,
} from "@/hooks/inventory/useInventoryReportRpcs";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import type {
  ExportConfig, ExportColumn, ExportRow,
} from "@/services/reports/ReportExportService";

type StatusFilter = "all" | "draft" | "approved" | "posted" | "reversed" | "cancelled";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  approved: "secondary",
  posted: "default",
  reversed: "destructive",
  cancelled: "outline",
};

function StockAdjustmentsReportInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();
  const { baseCurrency } = useCurrency();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [reason, setReason] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  const {
    data: rows = [],
    isLoading,
    error,
  } = useStockAdjustmentsReport({
    orgId: currentOrg?.id,
    businessId: currentBusiness?.id,
    filters: {
      branchId: scope.branchId ?? null,
      from: fromDate || null,
      to: toDate || null,
      status: status === "all" ? null : status,
      reason: reason === "all" ? null : reason,
    },
  });

  const reasons = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r: StockAdjustmentReportRow) => { if (r.reason) s.add(r.reason); });
    return Array.from(s).sort();
  }, [rows]);

  const kpis = useMemo(() => {
    // Σ posted cost impact may only sum LEDGER-BACKED rows. Adding an
    // unposted estimate into a posted total is exactly the misstatement the
    // server-side `cost_basis` flag exists to prevent.
    const posted = rows.filter(
      (r: StockAdjustmentReportRow) => r.cost_basis === "movement_ledger",
    );
    const pending = rows.filter(
      (r: StockAdjustmentReportRow) => r.status === "draft" || r.status === "approved",
    );
    return {
      total: rows.length,
      posted: rows.filter((r: StockAdjustmentReportRow) => r.status === "posted").length,
      pending: pending.length,
      cost: posted.reduce((a: number, r: StockAdjustmentReportRow) => a + Number(r.cost_impact), 0),
      estimatedCount: rows.filter(
        (r: StockAdjustmentReportRow) => r.cost_basis === "estimated_from_lines",
      ).length,
    };
  }, [rows]);

  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "adjustment_date", header: "Date", format: "date" },
      { key: "adjustment_number", header: "Adjustment #" },
      { key: "reason", header: "Reason" },
      {
        key: "status",
        header: "Status",
        render: (row) => (
          <Badge variant={STATUS_VARIANT[String(row.values?.status ?? "")] ?? "outline"}>
            {String(row.values?.status ?? "")}
          </Badge>
        ),
      },
      { key: "line_count", header: "Lines", format: "number" },
      { key: "abs_qty", header: "|Δ Qty|", format: "number" },
      { key: "cost_impact", header: "Cost Impact", format: "currency" },
      // The basis is part of the figure, not decoration: a reader must be
      // able to tell a posted ledger amount from an unposted estimate.
      { key: "cost_basis", header: "Cost basis" },
      {
        key: "actions",
        header: "",
        exportExclude: true,
        render: (row) => (
          <Button asChild variant="outline" size="sm">
            <Link to={`/inventory/adjustments/${row.id}`}>
              Open <ArrowRight className="h-3 w-3 ml-1" />
            </Link>
          </Button>
        ),
      },
    ],
    [],
  );

  const tableRows = useMemo<ReportRow[]>(
    () =>
      rows.map((r: StockAdjustmentReportRow) => ({
        id: r.adjustment_id,
        tone: r.status === "reversed" ? "warning" : "default",
        values: {
          adjustment_date: r.adjustment_date,
          adjustment_number: r.adjustment_number,
          reason: r.reason,
          status: r.status,
          line_count: Number(r.line_count),
          abs_qty: Number(Number(r.abs_qty).toFixed(2)),
          cost_impact: Number(r.cost_impact),
          cost_basis: COST_BASIS_LABEL[r.cost_basis] ?? r.cost_basis,
        },
      })),
    [rows],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "adjustment_date", header: "Date", width: 14 },
      { key: "adjustment_number", header: "Adjustment #", width: 22 },
      { key: "reason", header: "Reason", width: 22 },
      { key: "status", header: "Status", width: 14 },
      { key: "line_count", header: "Lines", width: 10, align: "right" },
      { key: "abs_qty", header: "|Δ Qty|", width: 14, align: "right" },
      { key: "cost_impact", header: "Cost Impact", width: 18, format: "currency", align: "right" },
      { key: "cost_basis", header: "Cost basis", width: 20 },
    ];
    const exportRows: ExportRow[] = rows.map((r: StockAdjustmentReportRow) => ({
      adjustment_date: r.adjustment_date ? format(new Date(r.adjustment_date), "yyyy-MM-dd") : "",
      adjustment_number: r.adjustment_number ?? "",
      reason: r.reason ?? "",
      status: r.status,
      line_count: Number(r.line_count),
      abs_qty: Number(r.abs_qty),
      cost_impact: Number(r.cost_impact),
      cost_basis: COST_BASIS_LABEL[r.cost_basis] ?? r.cost_basis,
    }));
    return {
      title: "Stock Adjustments Report",
      subtitle: "Operational adjustments with cost impact",
      columns, rows: exportRows, currency: baseCurrency,
    };
  }, [rows, baseCurrency]);


  return (
    <ReportPageLayout
      title="Stock Adjustments Report"
      description="Every inventory adjustment in scope with cost impact. Drill into an adjustment to inspect lines and posted journal entry."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No stock adjustments match the selected filters."
      getExportConfig={getExportConfig}
      filters={
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="posted">Posted</SelectItem>
                <SelectItem value="reversed">Reversed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All reasons</SelectItem>
                {reasons.map((r) => (
                  <SelectItem key={r} value={r}>{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">From</Label>
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard label="Adjustments" value={String(kpis.total)} />
          <KpiCard label="Posted" value={String(kpis.posted)} />
          <KpiCard label="Pending" value={String(kpis.pending)} />
          <KpiCard label="Σ posted cost impact" value={formatAccountingNumber(kpis.cost, baseCurrency)} />
        </div>

        <ReportSurface title="Stock Adjustments" profile="operational">
          <ReportTable
            columns={columns}
            rows={tableRows}
            currency={baseCurrency}
            caption="Stock adjustments"
            emptyMessage="No stock adjustments match the selected filters."
          />
        </ReportSurface>
      </div>
    </ReportPageLayout>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

export default function StockAdjustmentsReport() {
  return (
    <ReportFilterProvider>
      <StockAdjustmentsReportInner />
    </ReportFilterProvider>
  );
}
