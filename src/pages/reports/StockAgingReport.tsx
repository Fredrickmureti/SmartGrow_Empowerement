/**
 * Stock Aging — remaining COST LAYERS bucketed by age, AS AT a date.
 *
 * Phase 5 of the inventory reporting wave. Before this rebuild the page aged
 * the *product* by its last inbound movement and valued it at live on-hand ×
 * today's cost price, so a single fresh receipt made an entire slow-moving
 * balance look new and no total could tie to Inventory Valuation.
 *
 * It now reads `public.report_inventory_aging_as_of()` — the same RPC the
 * export path (`_shared/reports/inventoryData.ts`, registry key
 * `inventory_aging`) uses — which ages each remaining cost layer by its own
 * receipt date and enforces business / branch authorization server-side.
 * Bucket values sum to the Inventory Valuation total value at the same date.
 */
import { useState, useMemo, useCallback } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { DollarSign, Package, AlertTriangle } from "lucide-react";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { BranchScopeToggle, type BranchScope } from "@/components/reports/BranchScopeToggle";
import { format } from "date-fns";
import type { ServerBuildConfig } from "@/services/reports/ReportExportService";
import { useInventoryAgingAsOf } from "@/hooks/inventory/useInventoryReportRpcs";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { BranchScopeGate } from "@/components/inventory/BranchScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

const TOTAL_KEYS = [
  "qty_0_30",
  "value_0_30",
  "qty_31_60",
  "value_31_60",
  "qty_61_90",
  "value_61_90",
  "qty_90_plus",
  "value_90_plus",
  "qty_on_hand",
  "total_value",
] as const;

type TotalKey = (typeof TOTAL_KEYS)[number];

function StockAgingReportInner() {
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
  } = useInventoryAgingAsOf({
    orgId,
    businessId: bizId,
    asOf,
    filters: { branchId: effectiveBranchId },
  });

  const isLoading = rowsLoading || !currencyReady;

  const totals = useMemo(() => {
    const acc = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0])) as Record<TotalKey, number>;
    for (const r of rows) {
      for (const k of TOTAL_KEYS) acc[k] += Number(r[k] ?? 0);
    }
    return acc;
  }, [rows]);

  // Same keys, headers and order as the server column spec
  // (`columnSpecs.ts` → `inventory_aging`).
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "product_name", header: "Product" },
      { key: "sku", header: "SKU" },
      { key: "warehouse_name", header: "Warehouse" },
      { key: "value_0_30", header: "0-30", format: "currency", align: "right" },
      { key: "value_31_60", header: "31-60", format: "currency", align: "right" },
      { key: "value_61_90", header: "61-90", format: "currency", align: "right" },
      { key: "value_90_plus", header: "90+", format: "currency", align: "right" },
      { key: "qty_on_hand", header: "Qty on Hand", format: "number", align: "right" },
      { key: "total_value", header: "Total Value", format: "currency", align: "right" },
      { key: "oldest_receipt_at", header: "Oldest Receipt", format: "date" },
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
        value_0_30: Number(r.value_0_30 ?? 0),
        value_31_60: Number(r.value_31_60 ?? 0),
        value_61_90: Number(r.value_61_90 ?? 0),
        value_90_plus: Number(r.value_90_plus ?? 0),
        qty_on_hand: Number(r.qty_on_hand ?? 0),
        total_value: Number(r.total_value ?? 0),
        oldest_receipt_at: r.oldest_receipt_at ? String(r.oldest_receipt_at).slice(0, 10) : null,
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
        value_0_30: totals.value_0_30,
        value_31_60: totals.value_31_60,
        value_61_90: totals.value_61_90,
        value_90_plus: totals.value_90_plus,
        qty_on_hand: totals.qty_on_hand,
        total_value: totals.total_value,
        oldest_receipt_at: null,
      },
    });
    return detail;
  }, [rows, totals]);

  /**
   * Server-built export: `reportType` + org + as-of send `render-report` down
   * the same RPC path, so the PDF/CSV/XLSX carries the full dataset and cannot
   * drift from the screen.
   */
  const getExportConfig = useCallback(
    (): ServerBuildConfig => ({
      title: "Stock Aging",
      reportType: "inventory_aging",
      organizationId: orgId ?? undefined,
      businessId: bizId ?? undefined,
      branchId: effectiveBranchId,
      asOf,
      dateFrom: asOf,
      dateTo: asOf,
      filters: { branchId: effectiveBranchId, asOf },
      columns: [],
      rows: [],
      sheetName: "Aging",
      currency: baseCurrency,
    }),
    [orgId, bizId, effectiveBranchId, asOf, baseCurrency],
  );

  const oldValue = totals.value_61_90 + totals.value_90_plus;
  const oldShare = totals.total_value > 0 ? (oldValue / totals.total_value) * 100 : 0;

  return (
    <ReportPageLayout
      title="Stock Aging"
      description={`Cost layers bucketed by age as at ${format(new Date(asOf), "MMM d, yyyy")}`}
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No inventory on hand as at this date"
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
        <RefreshButton queryKeyPrefixes={[["inventory-aging-as-of"] as const]} tooltip="Refresh" />
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
                {formatCurrency(totals.total_value, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                Ties to Inventory Valuation at the same date
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Older than 60 Days</CardTitle>
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(oldValue, baseCurrency)}</div>
              <p className="text-xs text-muted-foreground">{oldShare.toFixed(1)}% of value</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Quantity on Hand</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totals.qty_on_hand.toLocaleString()}</div>
            </CardContent>
          </Card>
        </div>

        <ReportSurface
          title="Aging Buckets"
          subtitle={`Value by layer age as at ${asOf}`}
          profile="financial"
        >
          <ReportTable
            columns={[
              { key: "bucket", header: "Bucket" },
              { key: "qty", header: "Qty", format: "number", align: "right" },
              { key: "value", header: "Value", format: "currency", align: "right" },
            ]}
            rows={[
              { key: "0-30 days", q: totals.qty_0_30, v: totals.value_0_30 },
              { key: "31-60 days", q: totals.qty_31_60, v: totals.value_31_60 },
              { key: "61-90 days", q: totals.qty_61_90, v: totals.value_61_90 },
              { key: "90+ days", q: totals.qty_90_plus, v: totals.value_90_plus },
            ].map((b) => ({
              id: b.key,
              kind: "detail" as const,
              values: { bucket: b.key, qty: b.q, value: b.v },
            }))}
            currency={baseCurrency}
            caption="Aging summary"
            emptyMessage="No inventory on hand as at this date"
          />
        </ReportSurface>

        <ReportSurface
          title="Stock Aging"
          subtitle={`Cost-layer aging as at ${asOf} · ${rows.length} line(s)`}
          profile="financial"
        >
          <ReportTable
            columns={columns}
            rows={reportRows}
            currency={baseCurrency}
            caption="Stock aging as at date"
            emptyMessage="No inventory on hand as at this date"
          />
        </ReportSurface>
      </div>
    </ReportPageLayout>
  );
}

export default function StockAgingReport() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Stock aging">
        <BranchScopeGate pageName="Stock aging">
          <StockAgingReportInner />
        </BranchScopeGate>
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
