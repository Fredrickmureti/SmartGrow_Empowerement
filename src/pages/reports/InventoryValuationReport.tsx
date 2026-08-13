import { useState, useMemo, useCallback } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { Label } from "@/components/ui/label";
import { DollarSign, TrendingUp, Package, ArrowUp, ArrowDown } from "lucide-react";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { BranchScopeToggle, type BranchScope } from "@/components/reports/BranchScopeToggle";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";
import { formatBaseQtyAsPacks, type PackForRollup } from "@/lib/packagingRollup";
import { useLandedCostValuationAttribution } from "@/features/purchases/landed-costs/useLandedCostReporting";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
function InventoryValuationReportInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { products, isLoading: productsLoading } = useProducts();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  const [periodStart, setPeriodStart] = useState(() => format(startOfMonth(subMonths(new Date(), 0)), "yyyy-MM-dd"));
  const [periodEnd, setPeriodEnd] = useState(() => format(endOfMonth(new Date()), "yyyy-MM-dd"));
  const [scope, setScope] = useState<BranchScope>(currentBranch ? "branch" : "company");
  const effectiveBranchId = scope === "branch" ? currentBranch?.id ?? null : null;

  const isLoading = productsLoading || !currencyReady;
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;

  // Fetch movements within the period for each product
  const { data: periodMovements = [] } = useQuery({
    queryKey: ["valuation-movements", orgId, bizId, effectiveBranchId, periodStart, periodEnd],
    queryFn: async () => {
      if (!orgId || !bizId) return [];
      let query = supabase
        .from("stock_movements")
        .select("product_id, movement_type, quantity, unit_cost")
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .gte("movement_date", periodStart)
        .lte("movement_date", periodEnd + "T23:59:59");
      if (effectiveBranchId) query = query.eq("branch_id", effectiveBranchId);
      
      const allRows: any[] = [];
      let from = 0;
      let hasMore = true;
      while (hasMore) {
        const { data, error } = await query.range(from, from + 999);
        if (error) throw error;
        allRows.push(...(data || []));
        hasMore = (data || []).length === 1000;
        from += 1000;
      }
      return allRows;
    },
    enabled: !!orgId && !!bizId,
  });

  // Stage 9 (zero-trust audit): aggregate current quantity from warehouse_stock
  // (the per-branch source of truth) instead of products.stock_quantity (the
  // company-wide cached aggregate). This makes per-branch valuation correct.
  const { data: stockByProduct = new Map<string, number>() } = useQuery({
    queryKey: ["valuation-stock", orgId, bizId, effectiveBranchId],
    queryFn: async () => {
      if (!orgId || !bizId) return new Map<string, number>();
      let query = supabase
        .from("warehouse_stock")
        .select("product_id, quantity, branch_id")
        .eq("organization_id", orgId)
        .eq("business_id", bizId);
      if (effectiveBranchId) query = query.eq("branch_id", effectiveBranchId);

      const allRows: any[] = [];
      let from = 0;
      let hasMore = true;
      while (hasMore) {
        const { data, error } = await query.range(from, from + 999);
        if (error) throw error;
        allRows.push(...(data || []));
        hasMore = (data || []).length === 1000;
        from += 1000;
      }
      const map = new Map<string, number>();
      for (const r of allRows) {
        map.set(r.product_id, (map.get(r.product_id) ?? 0) + Number(r.quantity ?? 0));
      }
      return map;
    },
    enabled: !!orgId && !!bizId,
  });

  // Packaging definitions for the pack-rollup column. Lets us show
  // "120 (5 Carton)" instead of just "120 pcs" on busy product rows.
  const { byProduct: landedCostByProduct } = useLandedCostValuationAttribution();

  const { data: packsByProduct = new Map<string, PackForRollup[]>() } = useQuery({
    queryKey: ["valuation-packs", orgId, bizId],
    queryFn: async () => {
      if (!orgId || !bizId) return new Map<string, PackForRollup[]>();
      const { data, error } = await supabase
        .from("product_packaging")
        .select("product_id, name, qty_in_base_uom")
        .eq("organization_id", orgId)
        .eq("business_id", bizId);
      if (error) throw error;
      const map = new Map<string, PackForRollup[]>();
      for (const r of data ?? []) {
        const arr = map.get(r.product_id) ?? [];
        arr.push({ name: r.name, qty_in_base_uom: Number(r.qty_in_base_uom ?? 0) });
        map.set(r.product_id, arr);
      }
      return map;
    },
    enabled: !!orgId && !!bizId,
  });

  const physicalProducts = useMemo(
    () => products.filter((p) => p.type === "product" && p.is_active),
    [products]
  );

  const valuationData = useMemo(() => {
    // Group movements by product
    const movementsByProduct = new Map<string, { inQty: number; inValue: number; outQty: number; outValue: number }>();
    for (const m of periodMovements) {
      const entry = movementsByProduct.get(m.product_id) || { inQty: 0, inValue: 0, outQty: 0, outValue: 0 };
      const cost = m.unit_cost || 0;
      if (m.quantity > 0) {
        entry.inQty += m.quantity;
        entry.inValue += m.quantity * cost;
      } else {
        entry.outQty += Math.abs(m.quantity);
        entry.outValue += Math.abs(m.quantity) * cost;
      }
      movementsByProduct.set(m.product_id, entry);
    }

    const rows = physicalProducts.map((p) => {
      const costPrice = p.cost_price || 0;
      const currentQty = stockByProduct.get(p.id) ?? 0;
      const movements = movementsByProduct.get(p.id) || { inQty: 0, inValue: 0, outQty: 0, outValue: 0 };
      const closingValue = currentQty * costPrice;

      return {
        id: p.id,
        name: p.name,
        sku: p.sku || "",
        costPrice,
        currentQty,
        closingValue,
        inQty: movements.inQty,
        inValue: movements.inValue,
        outQty: movements.outQty,
        outValue: movements.outValue,
      };
    });

    const totalClosing = rows.reduce((s, r) => s + r.closingValue, 0);
    const totalIn = rows.reduce((s, r) => s + r.inValue, 0);
    const totalOut = rows.reduce((s, r) => s + r.outValue, 0);

    return { rows: rows.sort((a, b) => b.closingValue - a.closingValue), totalClosing, totalIn, totalOut };
  }, [physicalProducts, periodMovements, stockByProduct]);

  const valuationColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "product", header: "Product" },
      { key: "sku", header: "SKU" },
      { key: "qty", header: "Qty", format: "number" },
      {
        key: "packRollup",
        header: "Pack rollup",
        render: (row) => (
          <span className="text-muted-foreground text-xs">{String(row.values?.packRollup ?? "")}</span>
        ),
      },
      { key: "cost", header: "Unit Cost", format: "currency" },
      { key: "closing_value", header: "Closing Value", format: "currency" },
      {
        key: "landedCostUplift",
        header: "Landed cost in unit cost",
        align: "right",
        render: (row) => {
          const uplift = Number(row.values?.landedCostUplift ?? 0);
          if (!uplift) return <span className="text-muted-foreground">—</span>;
          const before = row.values?.landedCostUnitBefore;
          const after = row.values?.landedCostUnitAfter;
          return (
            <span title={
              before !== null && after !== null
                ? `Unit cost ${before} → ${after} after landed cost`
                : undefined
            }>
              {formatCurrency(uplift)}
            </span>
          );
        },
      },
      {
        key: "inQty",
        header: "In",
        align: "right",
        render: (row) => {
          const qty = Number(row.values?.inQty ?? 0);
          return <span className="text-success">{qty > 0 ? `+${qty}` : "—"}</span>;
        },
      },
      {
        key: "outQty",
        header: "Out",
        align: "right",
        render: (row) => {
          const qty = Number(row.values?.outQty ?? 0);
          return <span className="text-destructive">{qty > 0 ? `-${qty}` : "—"}</span>;
        },
      },
    ],
    [],
  );

  const valuationRows = useMemo<ReportRow[]>(
    () =>
      valuationData.rows.slice(0, 100).map((row) => ({
        id: row.id,
        values: {
          product: row.name,
          sku: row.sku || null,
          qty: row.currentQty,
          packRollup: formatBaseQtyAsPacks(row.currentQty, packsByProduct.get(row.id) ?? [], "ea"),
          cost: row.costPrice,
          closing_value: row.closingValue,
          inQty: row.inQty,
          outQty: row.outQty,
          landedCostUplift: landedCostByProduct.get(row.id)?.uplift_amount ?? 0,
          landedCostUnitBefore: landedCostByProduct.get(row.id)?.unit_cost_before ?? null,
          landedCostUnitAfter: landedCostByProduct.get(row.id)?.unit_cost_after ?? null,
        },
      })),
    [valuationData.rows, packsByProduct, landedCostByProduct],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    const exportRows: ExportRow[] = valuationData.rows.map((r) => ({
      product: r.name,
      sku: r.sku,
      qty: r.currentQty,
      cost: r.costPrice,
      closing_value: r.closingValue,
      in_qty: r.inQty,
      in_value: r.inValue,
      out_qty: r.outQty,
      out_value: r.outValue,
    }));
    exportRows.push({
      product: "TOTAL",
      sku: null,
      qty: null,
      cost: null,
      closing_value: valuationData.totalClosing,
      in_qty: null,
      in_value: valuationData.totalIn,
      out_qty: null,
      out_value: valuationData.totalOut,
      _isGrandTotal: true,
    });
    return {
      title: "Inventory Valuation Report",
      formatProfile: "financial",
      companyName: currentOrg?.name || "",
      columns: [
        { key: "product", header: "Product", width: 25 },
        { key: "sku", header: "SKU", width: 12 },
        { key: "qty", header: "Qty", width: 8, format: "number", align: "right" },
        { key: "cost", header: "Unit Cost", width: 12, format: "currency", align: "right" },
        { key: "closing_value", header: "Closing Value", width: 15, format: "currency", align: "right" },
        { key: "in_qty", header: "In Qty", width: 8, format: "number", align: "right" },
        { key: "in_value", header: "In Value", width: 12, format: "currency", align: "right" },
        { key: "out_qty", header: "Out Qty", width: 8, format: "number", align: "right" },
        { key: "out_value", header: "Out Value", width: 12, format: "currency", align: "right" },
      ],
      rows: exportRows,
      sheetName: "Valuation",
      currency: baseCurrency,
    };
  }, [valuationData, currentOrg, baseCurrency]);

  return (
    <ReportPageLayout
      title="Inventory Valuation Report"
      description={`Period: ${format(new Date(periodStart), "MMM d, yyyy")} — ${format(new Date(periodEnd), "MMM d, yyyy")}`}
      isLoading={isLoading}
      isEmpty={physicalProducts.length === 0}
      emptyMessage="No products found"
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="w-auto" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="w-auto" />
          </div>
          <BranchScopeToggle value={scope} onChange={setScope} />
        </div>
      }
      headerActions={<RefreshButton queryKeyPrefixes={[["valuation-movements"] as const]} tooltip="Refresh" />}
    >
      <div className="space-y-6">
        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Closing Inventory Value</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(valuationData.totalClosing, baseCurrency)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Period Inbound Value</CardTitle>
              <ArrowUp className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{formatCurrency(valuationData.totalIn, baseCurrency)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Period Outbound Value</CardTitle>
              <ArrowDown className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{formatCurrency(valuationData.totalOut, baseCurrency)}</div>
            </CardContent>
          </Card>
        </div>

        <ReportSurface title="Product Valuation" subtitle="Current stock value by product" profile="operational">
          <ReportTable
            columns={valuationColumns}
            rows={valuationRows}
            currency={baseCurrency}
            caption="Product valuation"
            emptyMessage="No products found"
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
