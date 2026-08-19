/**
 * Stock Ledger — the quantity ledger for a period.
 *
 * Phase 4 of the inventory reporting wave. Opening → in → out → closing per
 * product/warehouse, read from `public.report_stock_ledger()`: the same RPC
 * the export path (`_shared/reports/inventoryData.ts`, registry key
 * `stock_ledger`) uses, so the screen and the archived PDF are one dataset.
 *
 * The RPC is SECURITY DEFINER and asserts business/branch access; the browser
 * never derives quantities from movements itself, and closing quantity here
 * ties to `qty_on_hand` in Inventory Valuation at the same date (the tie-out
 * assertion in `supabase/tests/inventory_reporting_ratchet_test.sql`).
 */
import { useState, useMemo, useCallback } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { ArrowDownToLine, ArrowUpFromLine, Boxes } from "lucide-react";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { BranchScopeToggle, type BranchScope } from "@/components/reports/BranchScopeToggle";
import { format, startOfMonth } from "date-fns";
import type { ServerBuildConfig } from "@/services/reports/ReportExportService";
import { useStockLedger } from "@/hooks/inventory/useInventoryReportRpcs";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { BranchScopeGate } from "@/components/inventory/BranchScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

function StockLedgerReportInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const [dateFrom, setDateFrom] = useState(() => format(startOfMonth(new Date()), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [scope, setScope] = useState<BranchScope>(currentBranch ? "branch" : "company");
  const effectiveBranchId = scope === "branch" ? currentBranch?.id ?? null : null;

  const orgId = currentOrg?.id ?? null;
  const bizId = currentBusiness?.id ?? null;

  const {
    data: rows = [],
    isLoading,
    error,
  } = useStockLedger({
    orgId,
    businessId: bizId,
    dateFrom,
    dateTo,
    filters: { branchId: effectiveBranchId },
  });

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.opening += Number(r.opening_qty ?? 0);
          acc.in += Number(r.qty_in ?? 0);
          acc.out += Number(r.qty_out ?? 0);
          acc.closing += Number(r.closing_qty ?? 0);
          acc.movements += Number(r.movement_count ?? 0);
          return acc;
        },
        { opening: 0, in: 0, out: 0, closing: 0, movements: 0 },
      ),
    [rows],
  );

  // Same keys, headers and order as the server column spec
  // (`columnSpecs.ts` → `stock_ledger`).
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "product_name", header: "Product" },
      { key: "sku", header: "SKU" },
      { key: "warehouse_name", header: "Warehouse" },
      { key: "opening_qty", header: "Opening", format: "number", align: "right" },
      { key: "qty_in", header: "In", format: "number", align: "right" },
      { key: "qty_out", header: "Out", format: "number", align: "right" },
      { key: "closing_qty", header: "Closing", format: "number", align: "right" },
      { key: "movement_count", header: "Movements", format: "number", align: "right" },
    ],
    [],
  );

  const reportRows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = rows.map((r, i) => ({
      id: `${r.product_id}-${r.warehouse_id ?? "all"}-${i}`,
      kind: "detail",
      values: {
        product_name: r.product_name ?? "",
        sku: r.sku ?? null,
        warehouse_name: r.warehouse_name ?? "—",
        opening_qty: Number(r.opening_qty ?? 0),
        qty_in: Number(r.qty_in ?? 0),
        qty_out: Number(r.qty_out ?? 0),
        closing_qty: Number(r.closing_qty ?? 0),
        movement_count: Number(r.movement_count ?? 0),
      },
    }));

    if (detail.length === 0) return detail;

    detail.push({
      id: "grand-total",
      kind: "grandTotal",
      label: "Total",
      values: {
        product_name: "Total",
        sku: null,
        warehouse_name: null,
        opening_qty: totals.opening,
        qty_in: totals.in,
        qty_out: totals.out,
        closing_qty: totals.closing,
        movement_count: totals.movements,
      },
    });
    return detail;
  }, [rows, totals]);

  /** Server-built export: full dataset, canonical columns, identical to screen. */
  const getExportConfig = useCallback(
    (): ServerBuildConfig => ({
      title: "Stock Ledger",
      reportType: "stock_ledger",
      organizationId: orgId ?? undefined,
      businessId: bizId ?? undefined,
      branchId: effectiveBranchId,
      dateRange: `${dateFrom} to ${dateTo}`,
      dateFrom,
      dateTo,
      filters: { branchId: effectiveBranchId },
      columns: [],
      rows: [],
      sheetName: "Stock Ledger",
    }),
    [orgId, bizId, effectiveBranchId, dateFrom, dateTo],
  );

  return (
    <ReportPageLayout
      title="Stock Ledger"
      description="Opening, movement and closing quantities for the selected period"
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No stock movement in this period"
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-auto"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-auto"
            />
          </div>
          <BranchScopeToggle value={scope} onChange={setScope} />
        </div>
      }
      headerActions={
        <RefreshButton queryKeyPrefixes={[["inventory-stock-ledger"] as const]} tooltip="Refresh" />
      }
    >
      <div className="space-y-6">
        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Received (In)</CardTitle>
              <ArrowDownToLine className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totals.in.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Issued (Out)</CardTitle>
              <ArrowUpFromLine className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totals.out.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Closing Quantity</CardTitle>
              <Boxes className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totals.closing.toLocaleString()}</div>
            </CardContent>
          </Card>
        </div>

        <ReportSurface
          title="Stock Ledger"
          subtitle={`${dateFrom} → ${dateTo} · ${rows.length} line(s)`}
          profile="operational"
        >
          <ReportTable
            columns={columns}
            rows={reportRows}
            caption="Stock ledger for the selected period"
            emptyMessage="No stock movement in this period"
          />
        </ReportSurface>
      </div>
    </ReportPageLayout>
  );
}

export default function StockLedgerReport() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Stock ledger">
        <BranchScopeGate pageName="Stock ledger">
          <StockLedgerReportInner />
        </BranchScopeGate>
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
