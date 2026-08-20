/**
 * Stock Transfers Report — Phase B5, server-owned since Phase 8.
 *
 * Read-only observation of inter-warehouse / inter-branch transfer activity;
 * the transfer workflow remains the only write path.
 *
 * All aggregation (line counts, requested/sent/received quantities, and the
 * sent-vs-received variance) is now produced by `report_stock_transfers`.
 * The browser previously summed nested `stock_transfer_items`, which meant
 * the KPI row silently under-reported once the embedded read hit PostgREST's
 * 1,000-row cap — an in-transit variance that quietly disappears is worse
 * than no report at all.
 *
 * Scope: org + company are mandatory (the RPC refuses a null company);
 * branch comes from `useFinanceScope` and matches EITHER side of the
 * transfer, since a branch's outbound and inbound moves are both its
 * operational business.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import {
  useStockTransfersReport,
  type StockTransferReportRow,
} from "@/hooks/inventory/useInventoryReportRpcs";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import type {
  ExportConfig, ExportColumn, ExportRow,
} from "@/services/reports/ReportExportService";

type StatusFilter = "all" | "draft" | "approved" | "in_transit" | "completed" | "cancelled";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  approved: "secondary",
  in_transit: "secondary",
  completed: "default",
  cancelled: "outline",
};

function StockTransfersReportInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  const {
    data: rows = [],
    isLoading,
    error,
  } = useStockTransfersReport({
    orgId: currentOrg?.id,
    businessId: currentBusiness?.id,
    filters: {
      branchId: scope.branchId ?? null,
      from: fromDate || null,
      to: toDate || null,
      status: status === "all" ? null : status,
    },
  });

  const kpis = useMemo(() => {
    const inTransit = rows.filter((r: StockTransferReportRow) => r.status === "in_transit");
    const completed = rows.filter((r: StockTransferReportRow) => r.status === "completed");
    const variance = rows.reduce(
      (a: number, r: StockTransferReportRow) => a + Math.abs(Number(r.variance)),
      0,
    );
    return {
      total: rows.length,
      inTransit: inTransit.length,
      completed: completed.length,
      variance,
    };
  }, [rows]);

  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "transfer_date", header: "Date", format: "date" },
      { key: "transfer_number", header: "Transfer #" },
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
      { key: "qty_requested", header: "Requested", format: "number" },
      { key: "qty_sent", header: "Sent", format: "number" },
      { key: "qty_received", header: "Received", format: "number" },
      {
        key: "variance",
        header: "Variance",
        align: "right",
        render: (row) => {
          const variance = Number(row.values?.variance ?? 0);
          const hasVar = Math.abs(variance) > 0.0001;
          return (
            <span className={hasVar ? "text-amber-700 font-medium" : "text-muted-foreground"}>
              {variance.toFixed(2)}
            </span>
          );
        },
      },
      {
        key: "actions",
        header: "",
        exportExclude: true,
        render: (row) => (
          <Button asChild variant="outline" size="sm">
            <Link to={`/inventory/transfers/${row.id}`}>
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
      rows.map((r: StockTransferReportRow) => {
        const hasVar = Math.abs(Number(r.variance)) > 0.0001;
        return {
          id: r.transfer_id,
          tone: hasVar ? "warning" : "default",
          values: {
            transfer_date: r.transfer_date,
            transfer_number: r.transfer_number,
            status: r.status,
            line_count: Number(r.line_count),
            qty_requested: Number(Number(r.qty_requested).toFixed(2)),
            qty_sent: Number(Number(r.qty_sent).toFixed(2)),
            qty_received: Number(Number(r.qty_received).toFixed(2)),
            variance: Number(r.variance),
          },
        };
      }),
    [rows],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "transfer_date", header: "Date", width: 14 },
      { key: "transfer_number", header: "Transfer #", width: 22 },
      { key: "status", header: "Status", width: 14 },
      { key: "line_count", header: "Lines", width: 10, align: "right" },
      { key: "qty_requested", header: "Requested", width: 14, align: "right" },
      { key: "qty_sent", header: "Sent", width: 14, align: "right" },
      { key: "qty_received", header: "Received", width: 14, align: "right" },
      { key: "variance", header: "Variance", width: 14, align: "right" },
    ];
    const exportRows: ExportRow[] = rows.map((r: StockTransferReportRow) => ({
      transfer_date: r.transfer_date ? format(new Date(r.transfer_date), "yyyy-MM-dd") : "",
      transfer_number: r.transfer_number ?? "",
      status: r.status,
      line_count: Number(r.line_count),
      qty_requested: Number(r.qty_requested),
      qty_sent: Number(r.qty_sent),
      qty_received: Number(r.qty_received),
      variance: Number(r.variance),
    }));
    return {
      title: "Stock Transfers Report",
      subtitle: "Inter-warehouse / inter-branch transfer activity",
      columns, rows: exportRows,
    };
  }, [rows]);

  return (
    <ReportPageLayout
      title="Stock Transfers Report"
      description="Every inter-warehouse and inter-branch transfer in scope with sent/received variance. Drill into a transfer to inspect lines."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No stock transfers match the selected filters."
      getExportConfig={getExportConfig}
      filters={
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="in_transit">In transit</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
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
          <KpiCard label="Transfers" value={String(kpis.total)} />
          <KpiCard label="In transit" value={String(kpis.inTransit)} />
          <KpiCard label="Completed" value={String(kpis.completed)} />
          <KpiCard label="Σ |variance| qty" value={kpis.variance.toFixed(2)} />
        </div>

        <ReportSurface title="Stock Transfers" profile="operational">
          <ReportTable
            columns={columns}
            rows={tableRows}
            caption="Stock transfers"
            emptyMessage="No stock transfers match the selected filters."
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

export default function StockTransfersReport() {
  return (
    <ReportFilterProvider>
      <StockTransfersReportInner />
    </ReportFilterProvider>
  );
}
