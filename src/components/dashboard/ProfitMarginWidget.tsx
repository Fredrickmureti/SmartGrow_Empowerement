import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrency } from "@/hooks/useCurrency";
import { TrendingUp, TrendingDown, Percent, DollarSign } from "lucide-react";
import { ProfitMarginData } from "@/hooks/useDashboardAnalytics";
import { Progress } from "@/components/ui/progress";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface ProfitMarginWidgetProps {
  data: ProfitMarginData;
  displayCurrency: string;
}

export function ProfitMarginWidget({ data, displayCurrency }: ProfitMarginWidgetProps) {
  const { formatCurrency } = useCurrency();

  const marginColor = data.grossMargin >= 20 ? "text-success" : data.grossMargin >= 10 ? "text-warning" : "text-destructive";
  const progressColor = data.grossMargin >= 20 ? "bg-success" : data.grossMargin >= 10 ? "bg-warning" : "bg-destructive";

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
      {/* Gross Profit */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Gross Profit</CardDescription>
          <DollarSign className={`h-4 w-4 ${data.grossProfit >= 0 ? "text-success" : "text-destructive"}`} />
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${data.grossProfit >= 0 ? "text-success" : "text-destructive"}`}>
            {formatCurrency(data.grossProfit, displayCurrency)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Revenue - Expenses
          </p>
        </CardContent>
      </Card>

      {/* Gross Margin */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Gross Margin</CardDescription>
          <Percent className={`h-4 w-4 ${marginColor}`} />
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${marginColor}`}>
            {data.grossMargin.toFixed(1)}%
          </div>
          <div className="mt-2">
            <Progress value={Math.min(data.grossMargin, 100)} className="h-2" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {data.grossMargin >= 20 ? "Healthy margin" : data.grossMargin >= 10 ? "Average margin" : "Low margin"}
          </p>
        </CardContent>
      </Card>

      {/* Net Profit */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Net Profit</CardDescription>
          {data.netProfit >= 0 ? (
            <TrendingUp className="h-4 w-4 text-success" />
          ) : (
            <TrendingDown className="h-4 w-4 text-destructive" />
          )}
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${data.netProfit >= 0 ? "text-success" : "text-destructive"}`}>
            {formatCurrency(data.netProfit, displayCurrency)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            After all expenses
          </p>
        </CardContent>
      </Card>

      {/* Net Margin */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Net Margin</CardDescription>
          <Percent className={`h-4 w-4 ${marginColor}`} />
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${marginColor}`}>
            {data.netMargin.toFixed(1)}%
          </div>
          <div className="mt-2">
            <Progress value={Math.min(Math.max(data.netMargin, 0), 100)} className="h-2" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Of total revenue
          </p>
        </CardContent>
      </Card>

      {/* Margin Trend Chart */}
      <Card className="md:col-span-2 lg:col-span-4">
        <CardHeader>
          <CardTitle>Profit Margin Trend</CardTitle>
          <CardDescription>Monthly gross and net margins</CardDescription>
        </CardHeader>
        <CardContent>
          {data.marginTrend.some(d => d.grossMargin !== 0 || d.netMargin !== 0) ? (
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.marginTrend}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="period" className="text-xs" />
                  <YAxis 
                    className="text-xs" 
                    tickFormatter={(v) => `${v.toFixed(0)}%`}
                    domain={[0, 'auto']}
                  />
                  <Tooltip
                    formatter={(value: number) => `${value.toFixed(1)}%`}
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="grossMargin"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={{ fill: "hsl(var(--primary))" }}
                    name="Gross Margin"
                  />
                  <Line
                    type="monotone"
                    dataKey="netMargin"
                    stroke="hsl(var(--success))"
                    strokeWidth={2}
                    dot={{ fill: "hsl(var(--success))" }}
                    name="Net Margin"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[300px] text-muted-foreground">
              No margin data yet. Create invoices and record expenses to see trends.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
