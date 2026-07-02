import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrency } from "@/hooks/useCurrency";
import { ArrowDownLeft, ArrowUpRight, Wallet, TrendingUp } from "lucide-react";
import { CashFlowData } from "@/hooks/useDashboardAnalytics";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface CashFlowWidgetProps {
  data: CashFlowData;
  cashBalance: number;
  displayCurrency: string;
}

export function CashFlowWidget({ data, cashBalance, displayCurrency }: CashFlowWidgetProps) {
  const { formatCurrency, getCurrencySymbol } = useCurrency();
  const currencySymbol = getCurrencySymbol(displayCurrency);

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
      {/* Cash Balance */}
      <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Cash Balance</CardDescription>
          <Wallet className="h-4 w-4 text-primary" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-primary">
            {formatCurrency(cashBalance, displayCurrency)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Total in bank accounts
          </p>
        </CardContent>
      </Card>

      {/* Cash Inflows */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Cash Inflows</CardDescription>
          <ArrowDownLeft className="h-4 w-4 text-success" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-success">
            {formatCurrency(data.inflows, displayCurrency)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Customer payments received
          </p>
        </CardContent>
      </Card>

      {/* Cash Outflows */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Cash Outflows</CardDescription>
          <ArrowUpRight className="h-4 w-4 text-destructive" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-destructive">
            {formatCurrency(data.outflows, displayCurrency)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Bills & expenses paid
          </p>
        </CardContent>
      </Card>

      {/* Net Cash Flow */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Net Cash Flow</CardDescription>
          <TrendingUp className={`h-4 w-4 ${data.netCashFlow >= 0 ? "text-success" : "text-destructive"}`} />
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${data.netCashFlow >= 0 ? "text-success" : "text-destructive"}`}>
            {formatCurrency(data.netCashFlow, displayCurrency)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Inflows - Outflows
          </p>
        </CardContent>
      </Card>

      {/* Cash Flow Chart */}
      <Card className="md:col-span-2 lg:col-span-4">
        <CardHeader>
          <CardTitle>Cash Flow Trend</CardTitle>
          <CardDescription>Inflows vs Outflows over the last 6 months</CardDescription>
        </CardHeader>
        <CardContent>
          {data.cashFlowByPeriod.some(d => d.inflow > 0 || d.outflow > 0) ? (
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.cashFlowByPeriod}>
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
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="inflow"
                    stroke="hsl(var(--success))"
                    fill="hsl(var(--success) / 0.2)"
                    name="Inflows"
                  />
                  <Area
                    type="monotone"
                    dataKey="outflow"
                    stroke="hsl(var(--destructive))"
                    fill="hsl(var(--destructive) / 0.2)"
                    name="Outflows"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[300px] text-muted-foreground">
              No cash flow data yet. Record payments to see trends.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
