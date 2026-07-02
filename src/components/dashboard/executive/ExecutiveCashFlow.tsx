import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Landmark, TrendingUp, TrendingDown, ArrowRightLeft } from "lucide-react";
import type { CashFlowData } from "@/hooks/useDashboardAnalytics";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Line,
  ComposedChart,
  Legend,
} from "recharts";

interface ExecutiveCashFlowProps {
  cashFlow: CashFlowData | null;
  cashPosition: number;
  bankBalances: { accountName: string; balance: number; currency: string }[];
  displayAmount: (amount: number) => string;
  currencySymbol: string;
}

export function ExecutiveCashFlow({
  cashFlow,
  cashPosition,
  bankBalances,
  displayAmount,
  currencySymbol,
}: ExecutiveCashFlowProps) {
  const netCash = cashFlow?.netCashFlow || 0;
  const chartData = cashFlow?.cashFlowByPeriod || [];

  // Calculate burn rate (avg monthly outflow)
  const avgOutflow = chartData.length > 0
    ? chartData.reduce((s, d) => s + d.outflow, 0) / chartData.length
    : 0;
  const runwayMonths = avgOutflow > 0 ? cashPosition / avgOutflow : 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Cash summary cards */}
      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Cash Position</CardDescription>
            <Landmark className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className={`text-xl font-bold ${cashPosition >= 0 ? "text-primary" : "text-destructive"}`}>
              {displayAmount(cashPosition)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Combined bank balances</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Total Inflows</CardDescription>
            <TrendingUp className="h-4 w-4 text-success" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-success">{displayAmount(cashFlow?.inflows || 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">This period</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Total Outflows</CardDescription>
            <TrendingDown className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-destructive">{displayAmount(cashFlow?.outflows || 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">This period</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Net Cash Flow</CardDescription>
            <ArrowRightLeft className={`h-4 w-4 ${netCash >= 0 ? "text-success" : "text-destructive"}`} />
          </CardHeader>
          <CardContent>
            <div className={`text-xl font-bold ${netCash >= 0 ? "text-success" : "text-destructive"}`}>
              {displayAmount(netCash)}
            </div>
            {runwayMonths > 0 && runwayMonths < 24 && (
              <p className="text-xs text-muted-foreground mt-1">
                ~{runwayMonths.toFixed(0)} months runway
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cash Flow Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base sm:text-lg">Cash Flow Trend</CardTitle>
          <CardDescription>Inflows vs outflows over time</CardDescription>
        </CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ left: -10, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`}
                    width={50}
                  />
                  <Tooltip
                    formatter={(value: number) => displayAmount(value)}
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                  />
                  <Legend />
                  <Bar dataKey="inflow" fill="hsl(142, 76%, 36%)" name="Inflows" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="outflow" fill="hsl(0, 84%, 60%)" name="Outflows" radius={[4, 4, 0, 0]} />
                  <Line
                    type="monotone"
                    dataKey="inflow"
                    stroke="hsl(142, 76%, 36%)"
                    strokeWidth={0}
                    dot={false}
                    legendType="none"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[300px] text-muted-foreground">No cash flow data yet</div>
          )}
        </CardContent>
      </Card>

      {/* Bank Balances */}
      {bankBalances.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base sm:text-lg">Bank Accounts</CardTitle>
            <CardDescription>Balances for the current company</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {bankBalances.map((bank, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div className="flex items-center gap-2">
                    <Landmark className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{bank.accountName}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-semibold ${bank.balance >= 0 ? "text-success" : "text-destructive"}`}>
                      {displayAmount(bank.balance)}
                    </span>
                    <Badge variant="outline" className="text-[10px]">{bank.currency}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
