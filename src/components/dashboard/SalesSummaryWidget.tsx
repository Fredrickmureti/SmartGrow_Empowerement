import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrency } from "@/hooks/useCurrency";
import { TrendingUp, TrendingDown, ShoppingCart, Package } from "lucide-react";
import { SalesSummary } from "@/hooks/useDashboardAnalytics";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface SalesSummaryWidgetProps {
  data: SalesSummary;
  displayCurrency: string;
}

export function SalesSummaryWidget({ data, displayCurrency }: SalesSummaryWidgetProps) {
  const { formatCurrency, getCurrencySymbol } = useCurrency();
  const currencySymbol = getCurrencySymbol(displayCurrency);

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
      {/* Total Sales */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Total Sales</CardDescription>
          <ShoppingCart className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {formatCurrency(data.totalSales, displayCurrency)}
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
            {data.salesGrowth >= 0 ? (
              <TrendingUp className="h-3 w-3 text-success" />
            ) : (
              <TrendingDown className="h-3 w-3 text-destructive" />
            )}
            <span className={data.salesGrowth >= 0 ? "text-success" : "text-destructive"}>
              {Math.abs(data.salesGrowth).toFixed(1)}%
            </span>
            <span>vs last month</span>
          </div>
        </CardContent>
      </Card>

      {/* Sales Count */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Orders</CardDescription>
          <Package className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.salesCount}</div>
          <p className="text-xs text-muted-foreground mt-1">
            Total paid invoices
          </p>
        </CardContent>
      </Card>

      {/* Average Order Value */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Avg Order Value</CardDescription>
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {formatCurrency(data.avgOrderValue, displayCurrency)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Per invoice
          </p>
        </CardContent>
      </Card>

      {/* Top Product */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Top Product</CardDescription>
          <Package className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {data.topProducts.length > 0 ? (
            <>
              <div className="text-lg font-bold truncate">
                {data.topProducts[0].name}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {formatCurrency(data.topProducts[0].revenue, displayCurrency)} revenue
              </p>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">No data yet</div>
          )}
        </CardContent>
      </Card>

      {/* Sales by Period Chart */}
      <Card className="md:col-span-2 lg:col-span-2">
        <CardHeader>
          <CardTitle>Sales Trend</CardTitle>
          <CardDescription>Last 6 months</CardDescription>
        </CardHeader>
        <CardContent>
          {data.salesByPeriod.some(d => d.amount > 0) ? (
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.salesByPeriod}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="period" className="text-xs" />
                  <YAxis 
                    className="text-xs" 
                    tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} 
                  />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value, displayCurrency)}
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                  />
                  <Bar 
                    dataKey="amount" 
                    fill="hsl(var(--primary))" 
                    radius={[4, 4, 0, 0]}
                    name="Sales"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[200px] text-muted-foreground">
              No sales data yet
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top Products */}
      <Card className="md:col-span-2 lg:col-span-2">
        <CardHeader>
          <CardTitle>Top Products</CardTitle>
          <CardDescription>By revenue</CardDescription>
        </CardHeader>
        <CardContent>
          {data.topProducts.length > 0 ? (
            <div className="space-y-4">
              {data.topProducts.map((product, index) => (
                <div key={product.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium">
                      {index + 1}
                    </div>
                    <div>
                      <p className="text-sm font-medium truncate max-w-[180px]">{product.name}</p>
                      <p className="text-xs text-muted-foreground">{product.quantity} sold</p>
                    </div>
                  </div>
                  <p className="font-medium">
                    {formatCurrency(product.revenue, displayCurrency)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              No product data yet
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
