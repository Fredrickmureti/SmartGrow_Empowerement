/**
 * Inventory Valuation — the value ledger, AS AT a date.
 *
 * Phase 3 of the inventory reporting wave. Before this rebuild the page
 * multiplied *live* on-hand by *today's* AVCO, so no historical or period-end
 * figure it produced was correct and it could never tie to the GL.
 *
 * It now reads `public.report_inventory_valuation_as_of()` — the same RPC the
 * export path (`_shared/reports/inventoryData.ts`, registry key
 * `inventory_valuation`) uses — which reconstructs value from cost-layer
 * receipts less consumptions up to the reporting date, and enforces business /
 * branch authorization server-side. Screen and PDF are, by construction, the
 * same dataset.
 */
import { useState, useMemo, useCallback } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { Label } from "@/components/ui/label";
import { DollarSign, Package, Layers } from "lucide-react";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { BranchScopeToggle, type BranchScope } from "@/components/reports/BranchScopeToggle";
import { format } from "date-fns";
import type { ServerBuildConfig } from "@/services/reports/ReportExportService";
import { useInventoryValuationAsOf } from "@/hooks/inventory/useInventoryReportRpcs";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";

function InventoryValuationReportInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  const [asOf, setAsOf] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [scope, setScope] = useState<BranchScope>(currentBranch ? "branch" : "company");
  const effectiveBranchId = scope === "branch" ? currentBranch?.id ?? null : null;

  const orgId = currentOrg?.id ?? null;
  const bizId = currentBusiness?.id ?? null;

  const {
    data: rows = [],
    isLoading: rowsLoading,
    error,
  } = useInventoryValuationAsOf({
    orgId,
    businessId: bizId,
    asOf,
    filters: { branchId: effectiveBranchId },
  });

  const isLoading = rowsLoading || !currencyReady;

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.qty += Number(r.qty_on_hand ?? 0);
          acc.value += Number(r.total_value ?? 0);
          acc.layers += Number(r.layer_count ?? 0);
          return acc;
        },
        { qty: 0, value: 0, layers: 0 },
      ),
    [rows],
  );

  // Same keys, headers and order as the server column spec
  // (`columnSpecs.ts` → `inventory_valuation`).
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "product_name", header: "Product" },
      { key: "sku", header: "SKU" },
      { key: "warehouse_name", header: "Warehouse" },
      { key: "qty_on_hand", header: "Qty on Hand", format: "number", align: "right" },
      { key: "avg_unit_cost", header: "Avg Unit Cost", format: "currency", align: "right" },
      { key: "total_value", header: "Total Value", format: "currency", align: "right" },
      { key: "oldest_receipt_at", header: "Oldest Receipt", format: "date" },
      { key: "layer_count", header: "Layers", format: "number", align: "right" },
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
        qty_on_hand: Number(r.qty_on_hand ?? 0),
        avg_unit_cost: Number(r.avg_unit_cost ?? 0),
        total_value: Number(r.total_value ?? 0),
        oldest_receipt_at: r.oldest_receipt_at ? String(r.oldest_receipt_at).slice(0, 10) : null,
        layer_count: Number(r.layer_count ?? 0),
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
        qty_on_hand: totals.qty,
        avg_unit_cost: null,
        total_value: totals.value,
        oldest_receipt_at: null,
        layer_count: totals.layers,
      },
    });
    return detail;
  }, [rows, totals]);

  /**
   * Server-built export: `reportType` + org + period send `render-report`
   * down the same RPC path, so the PDF/CSV/XLSX contains the full dataset
   * and cannot drift from the screen.
   */
  const getExportConfig = useCallback(
    (): ServerBuildConfig => ({
      title: "Inventory Valuation",
      reportType: "inventory_valuation",
      organizationId: orgId ?? undefined,
      businessId: bizId ?? undefined,
      branchId: effectiveBranchId,
      asOf,
      dateFrom: asOf,
      dateTo: asOf,
      filters: { branchId: effectiveBranchId, asOf },
      columns: [],
      rows: [],
      sheetName: "Valuation",
      currency: baseCurrency,
    }),
    [orgId, bizId, effectiveBranchId, asOf, baseCurrency],
  );

  return (
    <ReportPageLayout
      title="Inventory Valuation"
      description={`Valued from cost layers as at ${format(new Date(asOf), "MMM d, yyyy")}`}
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No inventory value as at this date"
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <Label className="text-xs">As at</Label>
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="w-auto"
            />
          </div>
          <BranchScopeToggle value={scope} onChange={setScope} />
        </div>
      }
      headerActions={
        <RefreshButton
          queryKeyPrefixes={[["inventory-valuation-as-of"] as const]}
          tooltip="Refresh"
        />
      }
    >
      <div className="space-y-6">
        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Inventory Value</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totals.value, baseCurrency)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Quantity on Hand</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totals.qty.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Open Cost Layers</CardTitle>
              <Layers className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totals.layers.toLocaleString()}</div>
            </CardContent>
          </Card>
        </div>

        <ReportSurface
          title="Inventory Valuation"
          subtitle={`Cost-layer value as at ${asOf} · ${rows.length} line(s)`}
          profile="financial"
        >
          <ReportTable
            columns={columns}
            rows={reportRows}
            currency={baseCurrency}
            caption="Inventory valuation as at date"
            emptyMessage="No inventory value as at this date"
          />
        </ReportSurface>
      </div>
    </ReportPageLayout>
  );
}

import { BranchScopeGate } from "@/components/inventory/BranchScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

export default function InventoryValuationReport() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Inventory valuation">
        <BranchScopeGate pageName="Inventory valuation">
          <InventoryValuationReportInner />
        </BranchScopeGate>
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
