/**
 * Lot Traceability — lots / serials on hand AS AT a date, with expiry, control
 * status and value.
 *
 * Phase 7 of the inventory reporting wave. This is the reporting counterpart
 * to the operational `/inventory-app/lots` screens: those answer "what is this
 * lot doing right now", this answers "what did we hold, in which lots, at what
 * value, on this date — and what is expired, quarantined or recalled".
 *
 * It reads `public.report_lot_traceability_as_of()`, which asks the SAME shared
 * SQL helper the Inventory Valuation report uses (`_inventory_layer_valuation_as_of`)
 * for the lot grain. With "include depleted lots" off, the Value column
 * therefore sums to the Inventory Valuation total value at the same date. No
 * lot value is ever re-derived on the client.
 */
import { useState, useMemo, useCallback } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReportTable, type ReportColumn, type ReportRow } from "@/design-system/reports";
import { DollarSign, CalendarClock, ShieldAlert } from "lucide-react";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { BranchScopeToggle, type BranchScope } from "@/components/reports/BranchScopeToggle";
import { format } from "date-fns";
import type { ServerBuildConfig } from "@/services/reports/ReportExportService";
import { useLotTraceabilityAsOf } from "@/hooks/inventory/useInventoryReportRpcs";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { BranchScopeGate } from "@/components/inventory/BranchScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "quarantined", label: "Quarantined" },
  { value: "recalled", label: "Recalled" },
  { value: "inactive", label: "Inactive" },
  { value: "untracked", label: "No lot master" },
] as const;

const BUCKET_OPTIONS = [
  { value: "all", label: "Any expiry" },
  { value: "expired", label: "Expired" },
  { value: "0_30", label: "Within 30 days" },
  { value: "31_60", label: "31-60 days" },
  { value: "61_90", label: "61-90 days" },
  { value: "90_plus", label: "Over 90 days" },
  { value: "none", label: "No expiry date" },
] as const;

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  expired: "Expired",
  quarantined: "Quarantined",
  recalled: "Recalled",
  inactive: "Inactive",
  untracked: "No lot master",
};

function LotTraceabilityReportInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  const [asOf, setAsOf] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [scope, setScope] = useState<BranchScope>(currentBranch ? "branch" : "company");
  const [lot, setLot] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [bucket, setBucket] = useState<string>("all");
  const [includeDepleted, setIncludeDepleted] = useState(false);

  const effectiveBranchId = scope === "branch" ? currentBranch?.id ?? null : null;
  const orgId = currentOrg?.id ?? null;
  const bizId = currentBusiness?.id ?? null;

  const filters = useMemo(
    () => ({
      branchId: effectiveBranchId,
      lotNumber: lot.trim() ? lot.trim() : null,
      lotStatus: status === "all" ? null : status,
      expiryBucket: bucket === "all" ? null : bucket,
      includeDepleted,
    }),
    [effectiveBranchId, lot, status, bucket, includeDepleted],
  );

  const {
    data: rows = [],
    isLoading: rowsLoading,
    error,
  } = useLotTraceabilityAsOf({ orgId, businessId: bizId, asOf, filters });

  const isLoading = rowsLoading || !currencyReady;

  const totals = useMemo(() => {
    let qty = 0;
    let value = 0;
    let expiring = 0;
    let blocked = 0;
    for (const r of rows) {
      qty += Number(r.qty_on_hand ?? 0);
      value += Number(r.total_value ?? 0);
      if (r.expiry_bucket === "expired" || r.expiry_bucket === "0_30") {
        expiring += Number(r.total_value ?? 0);
      }
      if (r.lot_status === "quarantined" || r.lot_status === "recalled") {
        blocked += Number(r.total_value ?? 0);
      }
    }
    return { qty, value, expiring, blocked };
  }, [rows]);

  // Same keys, headers and order as the server column spec
  // (`columnSpecs.ts` → `lot_traceability`).
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "product_name", header: "Product", sticky: true },
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
        lot_status: STATUS_LABEL[r.lot_status] ?? r.lot_status,
        qty_received: Number(r.qty_received ?? 0),
        qty_consumed: Number(r.qty_consumed ?? 0),
        qty_on_hand: Number(r.qty_on_hand ?? 0),
        avg_unit_cost: Number(r.avg_unit_cost ?? 0),
        total_value: Number(r.total_value ?? 0),
        supplier_name: r.supplier_name ?? null,
        receipt_number: r.receipt_number ?? null,
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
        lot_number: null,
        expiry_date: null,
        days_to_expiry: null,
        lot_status: null,
        qty_received: null,
        qty_consumed: null,
        qty_on_hand: totals.qty,
        avg_unit_cost: null,
        total_value: totals.value,
        supplier_name: null,
        receipt_number: null,
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
      description={`Lots and serials held as at ${format(new Date(asOf), "MMM d, yyyy")}`}
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No lots match these filters as at this date"
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
              value={lot}
              onChange={(e) => setLot(e.target.value)}
              placeholder="Exact lot number"
              className="w-44"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
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
            <Select value={bucket} onValueChange={setBucket}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUCKET_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch
              id="include-depleted"
              checked={includeDepleted}
              onCheckedChange={setIncludeDepleted}
            />
            <Label htmlFor="include-depleted" className="text-xs">
              Include depleted lots
            </Label>
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
                {formatCurrency(totals.value, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                {includeDepleted
                  ? "Includes depleted lots — does not tie to Valuation"
                  : "Ties to Inventory Valuation at the same date"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Expired or Within 30 Days</CardTitle>
              <CalendarClock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totals.expiring, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">Value at expiry risk</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Quarantined or Recalled</CardTitle>
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totals.blocked, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">Value not free to sell</p>
            </CardContent>
          </Card>
        </div>

        <ReportSurface
          title="Lots on Hand"
          subtitle={`Lot-level position as at ${asOf} · ${rows.length} line(s)`}
          profile="financial"
        >
          <ReportTable
            columns={columns}
            rows={reportRows}
            currency={baseCurrency}
            caption="Lot traceability as at date"
            emptyMessage="No lots match these filters as at this date"
          />
        </ReportSurface>
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
