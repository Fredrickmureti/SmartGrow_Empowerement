/**
 * Stock Adjustments Report — Phase B5
 *
 * Read-only report over `stock_adjustments` + `stock_adjustment_items`.
 * Surfaces every adjustment in scope, its reason, status, line count and
 * cost impact (Σ quantity_adjustment × unit_cost). The actual write path
 * remains the inventory adjustment workflow — this page is observation
 * only. Scoping mirrors the bank-reconciliation report: org + business
 * always; branch via `useFinanceScope` (kind `stock_adjustment` is
 * branch-sliceable per `branchScopability.ts`).
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
import { supabase } from "@/integrations/supabase/client";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import type {
  ExportConfig, ExportColumn, ExportRow,
} from "@/services/reports/ReportExportService";

type StatusFilter = "all" | "draft" | "approved" | "posted" | "reversed" | "cancelled";

interface AdjustmentRow {
  id: string;
  adjustment_number: string;
  adjustment_date: string;
  reason: string | null;
  status: string;
  warehouse_id: string | null;
  branch_id: string | null;
  approved_at: string | null;
  reverses_adjustment_id: string | null;
  line_count: number;
  cost_impact: number;
  abs_qty: number;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  approved: "secondary",
  posted: "default",
  reversed: "destructive",
  cancelled: "outline",
};

function fmtMoney(n: number, ccy: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: ccy, maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

export default function StockAdjustmentsReport() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();
  const { baseCurrency } = useCurrency();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [reason, setReason] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: [
      "stock-adjustments-report",
      currentOrg?.id, currentBusiness?.id, scope.branchId,
      status, reason, fromDate, toDate,
    ],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<AdjustmentRow[]> => {
      let q = supabase
        .from("stock_adjustments")
        .select(`
          id, adjustment_number, adjustment_date, reason, status,
          warehouse_id, branch_id, approved_at, reverses_adjustment_id,
          items:stock_adjustment_items ( quantity_adjustment, unit_cost )
        `)
        .eq("organization_id", currentOrg!.id)
        .order("adjustment_date", { ascending: false });
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      if (scope.branchId) q = q.or(`branch_id.eq.${scope.branchId},branch_id.is.null`);
      if (status !== "all") q = q.eq("status", status);
      if (reason !== "all") q = q.eq("reason", reason);
      if (fromDate) q = q.gte("adjustment_date", fromDate);
      if (toDate) q = q.lte("adjustment_date", toDate);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((r: Record<string, unknown>) => {
        const items = (r.items as Array<Record<string, unknown>> | null) ?? [];
        let cost = 0;
        let absQty = 0;
        for (const it of items) {
          const q = Number(it.quantity_adjustment ?? 0);
          const c = Number(it.unit_cost ?? 0);
          cost += q * c;
          absQty += Math.abs(q);
        }
        return {
          id: r.id as string,
          adjustment_number: (r.adjustment_number as string) ?? "—",
          adjustment_date: r.adjustment_date as string,
          reason: (r.reason as string | null) ?? null,
          status: (r.status as string) ?? "draft",
          warehouse_id: (r.warehouse_id as string | null) ?? null,
          branch_id: (r.branch_id as string | null) ?? null,
          approved_at: (r.approved_at as string | null) ?? null,
          reverses_adjustment_id: (r.reverses_adjustment_id as string | null) ?? null,
          line_count: items.length,
          cost_impact: cost,
          abs_qty: absQty,
        };
      });
    },
  });

  const reasons = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => { if (r.reason) s.add(r.reason); });
    return Array.from(s).sort();
  }, [rows]);

  const kpis = useMemo(() => {
    const posted = rows.filter((r) => r.status === "posted");
    const pending = rows.filter((r) => r.status === "draft" || r.status === "approved");
    return {
      total: rows.length,
      posted: posted.length,
      pending: pending.length,
      cost: posted.reduce((a, r) => a + r.cost_impact, 0),
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
      rows.map((r) => ({
        id: r.id,
        tone: r.status === "reversed" ? "warning" : "default",
        values: {
          adjustment_date: r.adjustment_date,
          adjustment_number: r.adjustment_number,
          reason: r.reason,
          status: r.status,
          line_count: r.line_count,
          abs_qty: Number(r.abs_qty.toFixed(2)),
          cost_impact: r.cost_impact,
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
    ];
    const exportRows: ExportRow[] = rows.map((r) => ({
      adjustment_date: r.adjustment_date ? format(new Date(r.adjustment_date), "yyyy-MM-dd") : "",
      adjustment_number: r.adjustment_number,
      reason: r.reason ?? "",
      status: r.status,
      line_count: r.line_count,
      abs_qty: r.abs_qty,
      cost_impact: r.cost_impact,
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
          <KpiCard label="Σ posted cost impact" value={fmtMoney(kpis.cost, baseCurrency)} />
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