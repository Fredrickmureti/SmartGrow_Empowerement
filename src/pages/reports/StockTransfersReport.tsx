/**
 * Stock Transfers Report — Phase B5
 *
 * Read-only report over `stock_transfers` + `stock_transfer_items`.
 * Surfaces every inter-warehouse / inter-branch transfer with status,
 * line totals, and in-transit / variance picture. The transfer workflow
 * itself remains the only write path; this page is observation only.
 *
 * Scoping: org + business always; branch via `useFinanceScope`. Because
 * a transfer has both `from_branch_id` and `to_branch_id`, the branch
 * filter matches either side (a branch's "outbound" and "inbound"
 * transfers are both relevant to its operations report).
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
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import type {
  ExportConfig, ExportColumn, ExportRow,
} from "@/services/reports/ReportExportService";

type StatusFilter = "all" | "draft" | "approved" | "in_transit" | "completed" | "cancelled";

interface TransferRow {
  id: string;
  transfer_number: string;
  transfer_date: string;
  status: string;
  from_branch_id: string | null;
  to_branch_id: string | null;
  from_warehouse_id: string | null;
  to_warehouse_id: string | null;
  expected_arrival_date: string | null;
  actual_arrival_date: string | null;
  completed_at: string | null;
  line_count: number;
  qty_requested: number;
  qty_sent: number;
  qty_received: number;
  variance: number;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  approved: "secondary",
  in_transit: "secondary",
  completed: "default",
  cancelled: "outline",
};

export default function StockTransfersReport() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: [
      "stock-transfers-report",
      currentOrg?.id, currentBusiness?.id, scope.branchId,
      status, fromDate, toDate,
    ],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<TransferRow[]> => {
      let q = supabase
        .from("stock_transfers")
        .select(`
          id, transfer_number, transfer_date, status,
          from_branch_id, to_branch_id, from_warehouse_id, to_warehouse_id,
          expected_arrival_date, actual_arrival_date, completed_at,
          items:stock_transfer_items ( quantity_requested, quantity_sent, quantity_received )
        `)
        .eq("organization_id", currentOrg!.id)
        .order("transfer_date", { ascending: false });
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      if (scope.branchId) {
        // Either outbound or inbound for the active branch counts.
        q = q.or(`from_branch_id.eq.${scope.branchId},to_branch_id.eq.${scope.branchId}`);
      }
      if (status !== "all") q = q.eq("status", status);
      if (fromDate) q = q.gte("transfer_date", fromDate);
      if (toDate) q = q.lte("transfer_date", toDate);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((r: Record<string, unknown>) => {
        const items = (r.items as Array<Record<string, unknown>> | null) ?? [];
        let qReq = 0, qSent = 0, qRecv = 0;
        for (const it of items) {
          qReq += Number(it.quantity_requested ?? 0);
          qSent += Number(it.quantity_sent ?? 0);
          qRecv += Number(it.quantity_received ?? 0);
        }
        return {
          id: r.id as string,
          transfer_number: (r.transfer_number as string) ?? "—",
          transfer_date: r.transfer_date as string,
          status: (r.status as string) ?? "draft",
          from_branch_id: (r.from_branch_id as string | null) ?? null,
          to_branch_id: (r.to_branch_id as string | null) ?? null,
          from_warehouse_id: (r.from_warehouse_id as string | null) ?? null,
          to_warehouse_id: (r.to_warehouse_id as string | null) ?? null,
          expected_arrival_date: (r.expected_arrival_date as string | null) ?? null,
          actual_arrival_date: (r.actual_arrival_date as string | null) ?? null,
          completed_at: (r.completed_at as string | null) ?? null,
          line_count: items.length,
          qty_requested: qReq,
          qty_sent: qSent,
          qty_received: qRecv,
          variance: qSent - qRecv,
        };
      });
    },
  });

  const kpis = useMemo(() => {
    const inTransit = rows.filter((r) => r.status === "in_transit");
    const completed = rows.filter((r) => r.status === "completed");
    const variance = rows.reduce((a, r) => a + Math.abs(r.variance), 0);
    return {
      total: rows.length,
      inTransit: inTransit.length,
      completed: completed.length,
      variance,
    };
  }, [rows]);

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
    const exportRows: ExportRow[] = rows.map((r) => ({
      transfer_date: r.transfer_date ? format(new Date(r.transfer_date), "yyyy-MM-dd") : "",
      transfer_number: r.transfer_number,
      status: r.status,
      line_count: r.line_count,
      qty_requested: r.qty_requested,
      qty_sent: r.qty_sent,
      qty_received: r.qty_received,
      variance: r.variance,
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

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Transfer #</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Requested</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead className="w-[120px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const hasVar = Math.abs(r.variance) > 0.0001;
                  return (
                    <TableRow key={r.id} className={hasVar ? "bg-amber-50/40 dark:bg-amber-950/10" : ""}>
                      <TableCell className="font-mono text-xs">
                        {r.transfer_date ? format(new Date(r.transfer_date), "yyyy-MM-dd") : "—"}
                      </TableCell>
                      <TableCell className="font-medium">{r.transfer_number}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.line_count}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.qty_requested.toFixed(2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.qty_sent.toFixed(2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.qty_received.toFixed(2)}</TableCell>
                      <TableCell className={`text-right tabular-nums ${hasVar ? "text-amber-700 font-medium" : "text-muted-foreground"}`}>
                        {r.variance.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        <Button asChild variant="outline" size="sm">
                          <Link to={`/inventory/transfers/${r.id}`}>
                            Open <ArrowRight className="h-3 w-3 ml-1" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
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