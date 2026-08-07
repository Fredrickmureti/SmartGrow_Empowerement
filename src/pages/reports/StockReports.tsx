import { useMemo, useCallback } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useWarehouseStockTotals } from "@/hooks/useWarehouseStockTotals";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { Package, AlertTriangle, TrendingUp, DollarSign } from "lucide-react";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
function StockReportsInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { products, isLoading: productsLoading } = useProducts();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  // Branch-true totals — reads warehouse_stock, not products.stock_quantity.
  // products.stock_quantity is the company-wide cached aggregate; using it on
  // a branch-scoped report would silently surface another branch's stock.
  const totals = useWarehouseStockTotals({ branchScoped: !!currentBranch?.id });

  // Per-product branch-scoped on-hand for the value tables.
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;
  const { data: stockByProduct = new Map<string, number>() } = useQuery({
    queryKey: ["stock-reports-on-hand", orgId, bizId, branchId],
    queryFn: async () => {
      if (!orgId || !bizId) return new Map<string, number>();
      let q = supabase
        .from("warehouse_stock")
        .select("product_id, quantity")
        .eq("organization_id", orgId)
        .eq("business_id", bizId);
      if (branchId) q = q.eq("branch_id", branchId);
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

  const isLoading = productsLoading || !currencyReady || totals.isLoading;

  const stockData = useMemo(() => {
    const activeProducts = products.filter((p) => p.is_active);
    const physicalProducts = activeProducts.filter((p) => p.type === "product");

    // Branch-true total inventory value comes from useWarehouseStockTotals.
    const totalInventoryValue = totals.totalStockValue;

    const productsByValue = [...physicalProducts]
      .map((p) => {
        const stockQty = stockByProduct.get(p.id) ?? 0;
        const unitValue = p.cost_price || p.unit_price;
        return {
          ...p,
          stockQty,
          unitValue,
          totalValue: unitValue * stockQty,
        };
      })
      .sort((a, b) => b.totalValue - a.totalValue);

    const noCostPrice = physicalProducts.filter((p) => !p.cost_price);

    const productsWithMargin = physicalProducts.filter((p) => p.cost_price && p.cost_price > 0);
    const avgMargin = productsWithMargin.length > 0
      ? productsWithMargin.reduce((sum, p) => {
          const margin = ((p.unit_price - (p.cost_price || 0)) / p.unit_price) * 100;
          return sum + margin;
        }, 0) / productsWithMargin.length
      : 0;

    return {
      totalProducts: activeProducts.length,
      physicalProducts: physicalProducts.length,
      services: activeProducts.filter((p) => p.type === "service").length,
      totalInventoryValue,
      productsByValue: productsByValue.slice(0, 10),
      allProducts: productsByValue,
      noCostPrice,
      avgMargin,
    };
  }, [products, totals.totalStockValue, stockByProduct]);

  const topValueColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "product", header: "Product" },
      { key: "type", header: "Type", render: (row) => <Badge variant="outline">{String(row.values?.type ?? "")}</Badge> },
      { key: "cost", header: "Cost", format: "currency" },
      { key: "price", header: "Price", format: "currency" },
      {
        key: "margin",
        header: "Margin",
        align: "right",
        render: (row) => {
          const margin = row.values?.margin as number | null;
          if (margin === null || margin === undefined) return "—";
          return <span className={margin >= 30 ? "text-success" : "text-warning"}>{margin.toFixed(0)}%</span>;
        },
      },
    ],
    [],
  );

  const topValueRows = useMemo<ReportRow[]>(
    () =>
      stockData.productsByValue.map((product) => {
        const margin = product.cost_price
          ? ((product.unit_price - product.cost_price) / product.unit_price) * 100
          : null;
        return {
          id: product.id,
          values: {
            product: product.name,
            type: product.type,
            cost: product.cost_price || null,
            price: product.unit_price,
            margin,
          },
        };
      }),
    [stockData.productsByValue],
  );

  const missingCostColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "product", header: "Product" },
      { key: "sku", header: "SKU" },
      { key: "price", header: "Sale Price", format: "currency" },
    ],
    [],
  );

  const missingCostRows = useMemo<ReportRow[]>(
    () =>
      stockData.noCostPrice.slice(0, 10).map((product) => ({
        id: product.id,
        values: { product: product.name, sku: product.sku || null, price: product.unit_price },
      })),
    [stockData.noCostPrice],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    const rows: ExportRow[] = [];

    // Summary
    rows.push({ product: "INVENTORY SUMMARY", qty: null, cost: null, price: null, value: null, margin: null, _isHeader: true });
    rows.push({ product: `Total Products: ${stockData.physicalProducts}`, qty: null, cost: null, price: null, value: stockData.totalInventoryValue, margin: null, _depth: 1 });
    rows.push({ product: `Services: ${stockData.services}`, qty: null, cost: null, price: null, value: null, margin: null, _depth: 1 });
    rows.push({ product: `Average Margin: ${stockData.avgMargin.toFixed(1)}%`, qty: null, cost: null, price: null, value: null, margin: null, _depth: 1 });
    rows.push({ product: "", qty: null, cost: null, price: null, value: null, margin: null });

    // All products
    rows.push({ product: "PRODUCT DETAILS", qty: null, cost: null, price: null, value: null, margin: null, _isHeader: true });
    for (const p of stockData.allProducts) {
      const margin = p.cost_price ? ((p.unit_price - p.cost_price) / p.unit_price * 100) : null;
      rows.push({
        product: p.name,
        qty: p.stockQty,
        cost: p.cost_price || null,
        price: p.unit_price,
        value: p.totalValue,
        margin: margin ? Number(margin.toFixed(1)) : null,
      });
    }
    rows.push({
      product: "Total Inventory Value",
      qty: null,
      cost: null,
      price: null,
      value: stockData.totalInventoryValue,
      margin: null,
      _isGrandTotal: true,
    });

    return {
      title: "Stock / Inventory Report",
      companyName: currentOrg?.name || "",
      columns: [
        { key: "product", header: "Product", width: 30 },
        { key: "qty", header: "Qty", width: 10, format: "number", align: "right" },
        { key: "cost", header: "Cost Price", width: 15, format: "currency", align: "right" },
        { key: "price", header: "Sale Price", width: 15, format: "currency", align: "right" },
        { key: "value", header: "Total Value", width: 18, format: "currency", align: "right" },
        { key: "margin", header: "Margin %", width: 12, format: "percent", align: "right" },
      ],
      rows,
      sheetName: "Stock Report",
      currency: baseCurrency,
    };
  }, [stockData, currentOrg, baseCurrency]);

  return (
    <ReportPageLayout
      title="Stock Reports"
      description="Inventory valuation and product analytics"
      isLoading={isLoading}
      isEmpty={stockData.totalProducts === 0}
      emptyMessage="No products found"
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['stock-movements'] as const]} tooltip="Refresh stock reports" />
          <SaveViewButton reportType="stock" currentFilters={{}} onLoadView={() => {}} />
        </>
      }
    >
      <div className="space-y-6">
        <div className="stats-grid">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs sm:text-sm font-medium">Total Products</CardTitle>
              <Package className="h-4 w-4 text-blue-600 flex-shrink-0" />
            </CardHeader>
            <CardContent>
              <div className="stat-value">{stockData.totalProducts}</div>
              <p className="text-xs text-muted-foreground">
                {stockData.physicalProducts} products, {stockData.services} services
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs sm:text-sm font-medium">Inventory Value</CardTitle>
              <DollarSign className="h-4 w-4 text-green-600 flex-shrink-0" />
            </CardHeader>
            <CardContent>
              <div className="stat-value text-green-600">
                {formatCurrency(stockData.totalInventoryValue, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">Based on cost prices</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs sm:text-sm font-medium">Avg Margin</CardTitle>
              <TrendingUp className={`h-4 w-4 flex-shrink-0 ${stockData.avgMargin >= 30 ? "text-green-600" : "text-orange-600"}`} />
            </CardHeader>
            <CardContent>
              <div className={`stat-value ${stockData.avgMargin >= 30 ? "text-green-600" : "text-orange-600"}`}>
                {stockData.avgMargin.toFixed(1)}%
              </div>
              <p className="text-xs text-muted-foreground">Average profit margin</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs sm:text-sm font-medium">Missing Cost</CardTitle>
              <AlertTriangle className={`h-4 w-4 flex-shrink-0 ${stockData.noCostPrice.length > 0 ? "text-orange-600" : "text-green-600"}`} />
            </CardHeader>
            <CardContent>
              <div className={`stat-value ${stockData.noCostPrice.length > 0 ? "text-orange-600" : "text-green-600"}`}>
                {stockData.noCostPrice.length}
              </div>
              <p className="text-xs text-muted-foreground">Products without cost price</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
          <ReportSurface title="Top Products by Value" subtitle="Highest value items in inventory" profile="operational">
            <ReportTable
              columns={topValueColumns}
              rows={topValueRows}
              currency={baseCurrency}
              caption="Top products by value"
              emptyMessage="No products found"
            />
          </ReportSurface>

          <ReportSurface title="Products Missing Cost Price" subtitle="Update these for accurate margin calculations" profile="operational">
            <ReportTable
              columns={missingCostColumns}
              rows={missingCostRows}
              currency={baseCurrency}
              caption="Products missing cost price"
              emptyMessage="✓ All products have cost prices set"
            />
          </ReportSurface>
        </div>
      </div>
    </ReportPageLayout>
  );
}


import { ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { BranchScopeGate } from "@/components/inventory/BranchScopeGate";

export default function StockReports() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Stock reports">
        <BranchScopeGate pageName="Stock reports">
          <StockReportsInner />
        </BranchScopeGate>
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
