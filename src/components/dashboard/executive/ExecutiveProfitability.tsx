import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Percent, Users } from "lucide-react";
import type { ProfitMarginData, ExpenseCategoryData } from "@/hooks/useDashboardAnalytics";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

const PIE_COLORS = [
  "hsl(221, 83%, 53%)",
  "hsl(262, 83%, 58%)",
  "hsl(142, 76%, 36%)",
  "hsl(38, 92%, 50%)",
  "hsl(0, 84%, 60%)",
  "hsl(180, 70%, 45%)",
  "hsl(320, 70%, 50%)",
  "hsl(60, 70%, 45%)",
];

interface ExecutiveProfitabilityProps {
  profitMargin: ProfitMarginData | null;
  expenseCategories: ExpenseCategoryData | null;
  employeeCount: number;
  revenuePerEmployee: number;
  displayAmount: (amount: number) => string;
}

export function ExecutiveProfitability({
  profitMargin,
  expenseCategories,
  employeeCount,
  revenuePerEmployee,
  displayAmount,
}: ExecutiveProfitabilityProps) {
  const marginTrend = profitMargin?.marginTrend || [];
  const categories = expenseCategories?.categories || [];

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Margin summary cards */}
      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Gross Margin</CardDescription>
            <Percent className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{(profitMargin?.grossMargin || 0).toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground mt-1">
              Gross Profit: {displayAmount(profitMargin?.grossProfit || 0)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Net Margin</CardDescription>
            <Percent className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className={`text-xl font-bold ${(profitMargin?.netMargin || 0) >= 0 ? "text-success" : "text-destructive"}`}>
              {(profitMargin?.netMargin || 0).toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Net Profit: {displayAmount(profitMargin?.netProfit || 0)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Expense Growth</CardDescription>
            {(expenseCategories?.expenseGrowth || 0) >= 0 ? (
              <TrendingUp className="h-4 w-4 text-destructive" />
            ) : (
              <TrendingDown className="h-4 w-4 text-success" />
            )}
          </CardHeader>
          <CardContent>
            <div className={`text-xl font-bold ${(expenseCategories?.expenseGrowth || 0) >= 0 ? "text-destructive" : "text-success"}`}>
              {(expenseCategories?.expenseGrowth || 0).toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Total: {displayAmount(expenseCategories?.totalExpenses || 0)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Rev / Employee</CardDescription>
            <Users className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">
              {employeeCount > 0 ? displayAmount(revenuePerEmployee) : "N/A"}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {employeeCount} employee{employeeCount !== 1 ? "s" : ""}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-2">
        {/* Margin Trend */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base sm:text-lg">Margin Trend</CardTitle>
            <CardDescription>Gross & net margin over 6 months</CardDescription>
          </CardHeader>
          <CardContent>
            {marginTrend.length > 0 ? (
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={marginTrend} margin={{ left: -10, right: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} width={40} />
                    <Tooltip
                      formatter={(value: number) => `${value.toFixed(1)}%`}
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                    />
                    <Line type="monotone" dataKey="grossMargin" stroke="hsl(221, 83%, 53%)" strokeWidth={2} name="Gross Margin" dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="netMargin" stroke="hsl(142, 76%, 36%)" strokeWidth={2} name="Net Margin" dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex items-center justify-center h-[280px] text-muted-foreground">No margin data yet</div>
            )}
          </CardContent>
        </Card>

        {/* Expense Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base sm:text-lg">Expense Breakdown</CardTitle>
            <CardDescription>By category for the current company</CardDescription>
          </CardHeader>
          <CardContent>
            {categories.length > 0 ? (
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={categories.slice(0, 8)}
                      dataKey="amount"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={2}
                      label={(props: any) => `${props.name} (${Number(props.percentage ?? 0).toFixed(0)}%)`}
                      labelLine={{ strokeWidth: 1 }}
                    >
                      {categories.slice(0, 8).map((_, idx) => (
                        <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number) => displayAmount(value)}
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex items-center justify-center h-[280px] text-muted-foreground">No expense data yet</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
