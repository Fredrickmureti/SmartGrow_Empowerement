import { useMemo, useCallback, useState } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Clock, AlertTriangle, Package } from "lucide-react";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { BranchScopeToggle, type BranchScope } from "@/components/reports/BranchScopeToggle";
import { differenceInDays, format } from "date-fns";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";
import { useQtyFormatter } from "@/hooks/inventory/useQtyFormatter";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
function StockAgingReportInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { products, isLoading: productsLoading } = useProducts();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;
  const [scope, setScope] = useState<BranchScope>(currentBranch ? "branch" : "company");
  const effectiveBranchId = scope === "branch" ? currentBranch?.id ?? null : null;

  // Per-product on-hand from warehouse_stock — branch-true.
  // products.stock_quantity is a company-wide aggregate and must NEVER drive
  // branch-scoped reports.
  const { data: stockByProduct = new Map<string, number>() } = useQuery({
    queryKey: ["stock-aging-on-hand", orgId, bizId, effectiveBranchId],
    queryFn: async () => {
      if (!orgId || !bizId) return new Map<string, number>();
      let q = supabase
        .from("warehouse_stock")
        .select("product_id, quantity")
        .eq("organization_id", orgId)
        .eq("business_id", bizId);
      if (effectiveBranchId) q = q.eq("branch_id", effectiveBranchId);
      const { data, error } = await q;
      if (error) throw error;
      const map = new Map<string, number>();
      for (const r of data || []) {
        map.set(r.product_id, (map.get(r.product_id) || 0) + (Number(r.quantity) || 0));
      }
      return map;
    },
    enabled: !!orgId && !!bizId,
  });

  const isLoading = productsLoading || !currencyReady;

  // Fetch last inbound movement per product
  const { data: lastInbound = [] } = useQuery({
    queryKey: ["stock-aging-last-inbound", orgId, bizId, effectiveBranchId],
    queryFn: async () => {
      if (!orgId || !bizId) return [];
      // Get the most recent inbound movement per product
      let query = supabase
        .from("stock_movements")
        .select("product_id, movement_date, movement_type")
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .gt("quantity", 0)
        .in("movement_type", ["receipt", "purchase", "return_in", "adjustment", "count", "opening"])
        .order("movement_date", { ascending: false });
      if (effectiveBranchId) query = query.eq("branch_id", effectiveBranchId);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: !!orgId && !!bizId,
  });

  const physicalProducts = useMemo(
    () => products.filter(
      (p) => p.type === "product" && p.is_active && (stockByProduct.get(p.id) ?? 0) > 0
    ),
    [products, stockByProduct]
  );

  const agingData = useMemo(() => {
    const now = new Date();
    // Build map of most recent inbound per product
    const lastInboundMap = new Map<string, string>();
    for (const m of lastInbound) {
      if (!lastInboundMap.has(m.product_id)) {
        lastInboundMap.set(m.product_id, m.movement_date);
      }
    }

    const rows = physicalProducts.map((p) => {
      const lastDate = lastInboundMap.get(p.id);
      const daysAge = lastDate ? differenceInDays(now, new Date(lastDate)) : null;
      const qty = stockByProduct.get(p.id) ?? 0;
      const costPrice = p.cost_price || 0;
      const value = qty * costPrice;

      let ageBucket: string;
      if (daysAge === null) ageBucket = "Unknown";
      else if (daysAge <= 30) ageBucket = "0-30 days";
      else if (daysAge <= 60) ageBucket = "31-60 days";
      else if (daysAge <= 90) ageBucket = "61-90 days";
      else if (daysAge <= 180) ageBucket = "91-180 days";
      else ageBucket = "180+ days";

      return {
        id: p.id,
        name: p.name,
        sku: p.sku || "",
        qty,
        costPrice,
        value,
        lastInbound: lastDate || null,
        daysAge,
        ageBucket,
      };
    });

    const buckets = ["0-30 days", "31-60 days", "61-90 days", "91-180 days", "180+ days", "Unknown"];
    const summary = buckets.map((bucket) => {
      const items = rows.filter((r) => r.ageBucket === bucket);
      return {
        bucket,
        count: items.length,
        totalQty: items.reduce((s, r) => s + r.qty, 0),
        totalValue: items.reduce((s, r) => s + r.value, 0),
      };
    });

    return {
      rows: rows.sort((a, b) => (b.daysAge ?? 9999) - (a.daysAge ?? 9999)),
      summary,
      totalValue: rows.reduce((s, r) => s + r.value, 0),
      oldStockValue: rows.filter((r) => (r.daysAge ?? 0) > 90).reduce((s, r) => s + r.value, 0),
    };
  }, [physicalProducts, lastInbound, stockByProduct]);

  // Pack-aware qty formatter for the per-product rows.
  const qtyFormatter = useQtyFormatter({
    productIds: agingData.rows.map((r) => r.id),
  });

  const getExportConfig = useCallback((): ExportConfig => {
    const exportRows: ExportRow[] = agingData.rows.map((r) => ({
      product: r.name,
      sku: r.sku,
      qty: r.qty,
      cost: r.costPrice,
      value: r.value,
      last_inbound: r.lastInbound ? format(new Date(r.lastInbound), "yyyy-MM-dd") : "N/A",
      days_age: r.daysAge ?? "N/A",
      bucket: r.ageBucket,
    }));
    return {
      title: "Stock Aging Report",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      columns: [
        { key: "product", header: "Product", width: 25 },
        { key: "sku", header: "SKU", width: 12 },
        { key: "qty", header: "Qty", width: 8, format: "number", align: "right" },
        { key: "value", header: "Value", width: 15, format: "currency", align: "right" },
        { key: "last_inbound", header: "Last Inbound", width: 15 },
        { key: "days_age", header: "Days", width: 8, format: "number", align: "right" },
        { key: "bucket", header: "Age Bucket", width: 15 },
      ],
      rows: exportRows,
      sheetName: "Stock Aging",
      currency: baseCurrency,
    };
  }, [agingData, currentOrg, baseCurrency]);

  const getBucketColor = (bucket: string) => {
    if (bucket.includes("0-30")) return "bg-green-100 text-green-800";
    if (bucket.includes("31-60")) return "bg-blue-100 text-blue-800";
    if (bucket.includes("61-90")) return "bg-yellow-100 text-yellow-800";
    if (bucket.includes("91-180")) return "bg-orange-100 text-orange-800";
    if (bucket.includes("180+")) return "bg-red-100 text-red-800";
    return "bg-gray-100 text-gray-800";
  };

  return (
    <ReportPageLayout
      title="Stock Aging Report"
      description="Time since last inbound movement per product"
      isLoading={isLoading}
      isEmpty={physicalProducts.length === 0}
      emptyMessage="No products with stock found"
      getExportConfig={getExportConfig}
      headerActions={<RefreshButton queryKeyPrefixes={[["stock-aging-last-inbound"] as const]} tooltip="Refresh" />}
      filters={
        <div className="flex flex-wrap gap-3 items-end">
          <BranchScopeToggle value={scope} onChange={setScope} />
        </div>
      }
    >
      <div className="space-y-6">
        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Total Stock Value</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(agingData.totalValue, baseCurrency)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Aging Stock (&gt;90 days)</CardTitle>
              <AlertTriangle className="h-4 w-4 text-orange-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-orange-600">{formatCurrency(agingData.oldStockValue, baseCurrency)}</div>
              <p className="text-xs text-muted-foreground">
                {agingData.totalValue > 0 ? ((agingData.oldStockValue / agingData.totalValue) * 100).toFixed(1) : 0}% of total
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Products in Stock</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{physicalProducts.length}</div>
            </CardContent>
          </Card>
        </div>

        {/* Age Buckets Summary */}
        <Card>
          <CardHeader>
            <CardTitle>Age Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {agingData.summary.map((s) => (
                <div key={s.bucket} className="rounded-lg border p-3 text-center">
                  <Badge className={getBucketColor(s.bucket)}>{s.bucket}</Badge>
                  <p className="mt-2 text-lg font-bold">{s.count}</p>
                  <p className="text-xs text-muted-foreground">{formatCurrency(s.totalValue, baseCurrency)}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Detail table */}
        <Card>
          <CardHeader>
            <CardTitle>Stock Details</CardTitle>
            <CardDescription>Sorted by age (oldest first)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead>Last Inbound</TableHead>
                    <TableHead className="text-right">Days</TableHead>
                    <TableHead>Bucket</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agingData.rows.slice(0, 100).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell className="text-muted-foreground">{row.sku || "—"}</TableCell>
                      <TableCell className="text-right">{qtyFormatter.format(row.id, row.qty)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(row.value, baseCurrency)}</TableCell>
                      <TableCell>
                        {row.lastInbound ? format(new Date(row.lastInbound), "MMM d, yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {row.daysAge ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge className={getBucketColor(row.ageBucket)} variant="outline">{row.ageBucket}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </ReportPageLayout>
  );
}


import { BranchScopeGate } from "@/components/inventory/BranchScopeGate";

export default function StockAgingReport() {
  return (
    <CompanyScopeGate reportName="Stock aging">
      <BranchScopeGate pageName="Stock aging">
        <StockAgingReportInner />
      </BranchScopeGate>
    </CompanyScopeGate>
  );
}
