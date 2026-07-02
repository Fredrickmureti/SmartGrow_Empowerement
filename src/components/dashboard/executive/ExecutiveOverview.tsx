import { useDashboardStats } from "@/hooks/useDashboardStats";
import { useExecutiveStats } from "@/hooks/useExecutiveStats";
import { useOrganization } from "@/hooks/useOrganization";
import { useCurrency } from "@/hooks/useCurrency";
import { useViewCurrencyPreference } from "@/hooks/useViewCurrencyPreference";
import { ExecutiveKPICards } from "./ExecutiveKPICards";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, TrendingUp, TrendingDown } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface ExecutiveOverviewProps {
  stats: ReturnType<typeof useDashboardStats>["stats"];
  execStats: ReturnType<typeof useExecutiveStats>["stats"];
  displayAmount: (amount: number) => string;
  currencySymbol: string;
}

export function ExecutiveOverview({ stats, execStats, displayAmount, currencySymbol }: ExecutiveOverviewProps) {
  const chartData = stats.monthlyRevenue.map((rev, i) => ({
    month: rev.month,
    revenue: rev.amount,
    expenses: stats.monthlyExpenses[i]?.amount || 0,
  }));

  const businessCount = execStats.businessScorecards.length;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Summary sentence */}
      {stats.totalRevenue > 0 && (
        <p className="text-sm text-muted-foreground">
          Your organization generated <span className="font-semibold text-foreground">{displayAmount(stats.totalRevenue)}</span> in revenue
          across <span className="font-semibold text-foreground">{businessCount}</span> business{businessCount !== 1 ? "es" : ""} this period.
        </p>
      )}

      {/* KPI Cards */}
      <ExecutiveKPICards
        totalRevenue={stats.totalRevenue}
        totalRevenueChange={stats.totalRevenueChange}
        totalExpenses={stats.totalExpenses}
        totalExpensesChange={stats.totalExpensesChange}
        netProfit={stats.netProfit}
        totalReceivables={execStats.totalReceivables}
        totalPayables={execStats.totalPayables}
        cashPosition={execStats.cashPosition}
        totalCustomers={execStats.totalCustomers}
        displayAmount={displayAmount}
      />

      {/* Revenue Trend + Customer Growth */}
      <div className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base sm:text-lg">Revenue vs Expenses Trend</CardTitle>
            <CardDescription>Last 6 months consolidated</CardDescription>
          </CardHeader>
          <CardContent>
            {chartData.some(d => d.revenue > 0 || d.expenses > 0) ? (
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ left: -10, right: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} />
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
                    <Area type="monotone" dataKey="revenue" stroke="hsl(142, 76%, 36%)" fill="hsl(142, 76%, 36%, 0.2)" name="Revenue" />
                    <Area type="monotone" dataKey="expenses" stroke="hsl(0, 84%, 60%)" fill="hsl(0, 84%, 60%, 0.2)" name="Expenses" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex items-center justify-center h-[280px] text-muted-foreground">No data yet</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Users className="h-4 w-4 text-primary" />
              Customer Growth
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-3xl font-bold">{execStats.totalCustomers}</p>
              <p className="text-xs text-muted-foreground">Total customers org-wide</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-lg font-semibold">{execStats.newCustomersThisMonth}</p>
                <p className="text-xs text-muted-foreground">New this month</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-lg font-semibold">{execStats.newCustomersLastMonth}</p>
                <p className="text-xs text-muted-foreground">Last month</p>
              </div>
            </div>
            {execStats.customerGrowth !== 0 && (
              <div className="flex items-center gap-1 text-sm">
                {execStats.customerGrowth >= 0 ? (
                  <TrendingUp className="h-4 w-4 text-success" />
                ) : (
                  <TrendingDown className="h-4 w-4 text-destructive" />
                )}
                <span className={execStats.customerGrowth >= 0 ? "text-success" : "text-destructive"}>
                  {execStats.customerGrowth >= 0 ? "+" : ""}{execStats.customerGrowth.toFixed(1)}%
                </span>
                <span className="text-muted-foreground">growth</span>
              </div>
            )}
            {/* Operational KPIs */}
            {execStats.employeeCount > 0 && (
              <div className="border-t pt-3 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Employees</span>
                  <span className="font-medium">{execStats.employeeCount}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Rev / Employee</span>
                  <span className="font-medium">{displayAmount(execStats.revenuePerEmployee)}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
