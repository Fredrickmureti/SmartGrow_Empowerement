/**
 * Lot Traceability — lot / serial positions AS AT a date.
 *
 * Phase 7 of the inventory reporting wave. One dimension-driven report family
 * (business, branch, warehouse, product, lot/serial, expiry window, status),
 * NOT a second operational lots screen: `/inventory-app/lots` stays the
 * master-data surface (ADR 0070).
 *
 * Reads `public.report_lot_traceability_as_of()` — the same RPC the export path
 * (`_shared/reports/inventoryData.ts`, registry key `lot_traceability`) uses.
 * Value comes from the shared `_inventory_layer_valuation_as_of` helper at lot
 * grain, so the value column ties to Inventory Valuation at the same date; no
 * client-side valuation arithmetic exists here.
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { DollarSign, AlertTriangle, ShieldAlert } from "lucide-react";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { BranchScopeToggle, type BranchScope } from "@/components/reports/BranchScopeToggle";
import { format } from "date-fns";
import type { ServerBuildConfig } from "@/services/reports/ReportExportService";
import { useLotTraceabilityAsOf } from "@/hooks/inventory/useInventoryReportRpcs";
import {
  LotGenealogyDialog,
  type LotGenealogyTarget,
} from "@/components/reports/LotGenealogyDialog";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { BranchScopeGate } from "@/components/inventory/BranchScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

const ALL = "__all__";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "quarantined", label: "Quarantined" },
  { value: "recalled", label: "Recalled" },
  { value: "inactive", label: "Inactive" },
  { value: "untracked", label: "Untracked (no lot master)" },
];

const EXPIRY_OPTIONS = [
  { value: "expired", label: "Expired" },
  { value: "0_30", label: "Within 30 days" },
  { value: "31_60", label: "31-60 days" },
  { value: "61_90", label: "61-90 days" },
  { value: "90_plus", label: "90+ days" },
  { value: "none", label: "No expiry" },
];

function LotTraceabilityReportInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  const [asOf, setAsOf] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [lotNumber, setLotNumber] = useState("");
  const [status, setStatus] = useState<string>(ALL);
  const [expiryBucket, setExpiryBucket] = useState<string>(ALL);
  const [scope, setScope] = useState<BranchScope>(currentBranch ? "branch" : "company");
  const [drillTarget, setDrillTarget] = useState<LotGenealogyTarget | null>(null);
  const effectiveBranchId = scope === "branch" ? currentBranch?.id ?? null : null;


  const orgId = currentOrg?.id ?? null;
  const bizId = currentBusiness?.id ?? null;

  const filters = useMemo(
    () => ({
      branchId: effectiveBranchId,
      lotNumber: lotNumber.trim() || null,
      lotStatus: status === ALL ? null : status,
      expiryBucket: expiryBucket === ALL ? null : expiryBucket,
    }),
    [effectiveBranchId, lotNumber, status, expiryBucket],
  );

  const {
    data: rows = [],
    isLoading: rowsLoading,
    error,
  } = useLotTraceabilityAsOf({ orgId, businessId: bizId, asOf, filters });

  const isLoading = rowsLoading || !currencyReady;

  const totals = useMemo(() => {
    let qtyOnHand = 0;
    let totalValue = 0;
    let expiringValue = 0;
    let blockedValue = 0;
    for (const r of rows) {
      qtyOnHand += Number(r.qty_on_hand ?? 0);
      totalValue += Number(r.total_value ?? 0);
      if (r.expiry_bucket === "expired" || r.expiry_bucket === "0_30") {
        expiringValue += Number(r.total_value ?? 0);
      }
      if (r.lot_status === "quarantined" || r.lot_status === "recalled") {
        blockedValue += Number(r.total_value ?? 0);
      }
    }
    return { qtyOnHand, totalValue, expiringValue, blockedValue };
  }, [rows]);

  // Same keys, headers and order as the server column spec
  // (`columnSpecs.ts` → `lot_traceability`).
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "product_name", header: "Product" },
      { key: "sku", header: "SKU" },
      { key: "warehouse_name", header: "Warehouse" },
      { key: "lot_number", header: "Lot / Serial" },
      { key: "expiry_date", header: "Expiry", format: "date" },
      { key: "days_to_expiry", header: "Days", format: "number", align: "right" },
      { key: "lot_status", header: "Status" },
      { key: "qty_received", header: "Received", format: "number", align: "right" },
      { key: "qty_consumed", header: "Consumed", format: "number", align: "right" },
      { key: "qty_on_hand", header: "On Hand", format: "number", align: "right" },
      { key: "avg_unit_cost", header: "Unit Cost", format: "currency", align: "right" },
      { key: "total_value", header: "Value", format: "currency", align: "right" },
      { key: "supplier_name", header: "Supplier" },
      { key: "receipt_number", header: "Receipt" },
    ],
    [],
  );

  const reportRows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = rows.map((r, i) => ({
      id: `${r.product_id}-${r.warehouse_id ?? "all"}-${r.lot_number ?? "none"}-${i}`,
      kind: "detail",
      values: {
        product_name: r.product_name ?? "",
        sku: r.sku ?? null,
        warehouse_name: r.warehouse_name ?? "—",
        lot_number: r.lot_number ?? "—",
        expiry_date: r.expiry_date ? String(r.expiry_date).slice(0, 10) : null,
        days_to_expiry: r.days_to_expiry === null ? null : Number(r.days_to_expiry),
        lot_status: r.lot_status ?? "",
        qty_received: Number(r.qty_received ?? 0),
        qty_consumed: Number(r.qty_consumed ?? 0),
        qty_on_hand: Number(r.qty_on_hand ?? 0),
        avg_unit_cost: Number(r.avg_unit_cost ?? 0),
        total_value: Number(r.total_value ?? 0),
        supplier_name: r.supplier_name ?? "",
        receipt_number: r.receipt_number ?? "",
      },
      // Drill-down: backward / forward trace for this exact lot. The value
      // shown in the panel is the row's value, not a second computation.
      onClick: r.lot_number
        ? () =>
            setDrillTarget({
              businessId: bizId,
              productId: r.product_id,
              lotNumber: r.lot_number,
              productName: r.product_name,
              sku: r.sku,
              warehouseName: r.warehouse_name,
              supplierName: r.supplier_name,
              receiptNumber: r.receipt_number,
              expiryDate: r.expiry_date,
              lotStatus: r.lot_status,
              valueLabel: formatCurrency(Number(r.total_value ?? 0), baseCurrency),
            })
        : undefined,
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
        lot_number: null,
        expiry_date: null,
        days_to_expiry: null,
        lot_status: null,
        qty_received: null,
        qty_consumed: null,
        qty_on_hand: totals.qtyOnHand,
        avg_unit_cost: null,
        total_value: totals.totalValue,
        supplier_name: null,
        receipt_number: null,
      },
    });
    return detail;
  }, [rows, totals, bizId, formatCurrency, baseCurrency]);

  /**
   * Server-built export: the same reportType + as-of + dimensions send
   * `render-report` down the same RPC, so PDF/CSV/XLSX cannot drift from screen.
   */
  const getExportConfig = useCallback(
    (): ServerBuildConfig => ({
      title: "Lot Traceability",
      reportType: "lot_traceability",
      organizationId: orgId ?? undefined,
      businessId: bizId ?? undefined,
      branchId: effectiveBranchId,
      asOf,
      dateFrom: asOf,
      dateTo: asOf,
      filters: { ...filters, asOf },
      columns: [],
      rows: [],
      sheetName: "Lots",
      currency: baseCurrency,
    }),
    [orgId, bizId, effectiveBranchId, asOf, filters, baseCurrency],
  );

  return (
    <ReportPageLayout
      title="Lot Traceability"
      description={`Lot / serial positions, expiry and control status as at ${format(new Date(asOf), "MMM d, yyyy")}`}
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No lot-tracked stock on hand as at this date"
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
          <div className="space-y-1">
            <Label className="text-xs">Lot / serial</Label>
            <Input
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              placeholder="Exact number"
              className="w-40"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Expiry</Label>
            <Select value={expiryBucket} onValueChange={setExpiryBucket}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All windows" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All windows</SelectItem>
                {EXPIRY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <BranchScopeToggle value={scope} onChange={setScope} />
        </div>
      }
      headerActions={
        <RefreshButton
          queryKeyPrefixes={[["inventory-lot-traceability-as-of"] as const]}
          tooltip="Refresh"
        />
      }
    >
      <div className="space-y-6">
        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Lot Value</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totals.totalValue, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                Same cost-layer basis as Inventory Valuation
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Expiry Risk</CardTitle>
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totals.expiringValue, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">Expired or expiring within 30 days</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Blocked Value</CardTitle>
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totals.blockedValue, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">Quarantined or recalled lots</p>
            </CardContent>
          </Card>
        </div>

        <ReportSurface
          title="Lot Traceability"
          subtitle={`Lot positions as at ${asOf} · ${rows.length} line(s)`}
          profile="financial"
        >
          <ReportTable
            columns={columns}
            rows={reportRows}
            currency={baseCurrency}
            caption="Lot / serial traceability as at date"
            emptyMessage="No lot-tracked stock on hand as at this date"
          />
        </ReportSurface>

        <LotGenealogyDialog
          open={!!drillTarget}
          onOpenChange={(o) => !o && setDrillTarget(null)}
          target={drillTarget}
        />

      </div>
    </ReportPageLayout>
  );
}

export default function LotTraceabilityReport() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Lot traceability">
        <BranchScopeGate pageName="Lot traceability">
          <LotTraceabilityReportInner />
        </BranchScopeGate>
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
