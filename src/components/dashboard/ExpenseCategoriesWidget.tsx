import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrency } from "@/hooks/useCurrency";
import { TrendingUp, TrendingDown, Receipt, PieChart as PieChartIcon } from "lucide-react";
import { ExpenseCategoryData } from "@/hooks/useDashboardAnalytics";
import { Progress } from "@/components/ui/progress";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from "recharts";

interface ExpenseCategoriesWidgetProps {
  data: ExpenseCategoryData;
  displayCurrency: string;
}

export function ExpenseCategoriesWidget({ data, displayCurrency }: ExpenseCategoriesWidgetProps) {
  const { formatCurrency } = useCurrency();

  const chartData = data.categories.map(cat => ({
    name: cat.name,
    value: cat.amount,
    color: cat.color,
  }));

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {/* Total Expenses */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Total Expenses</CardDescription>
          <Receipt className="h-4 w-4 text-destructive" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {formatCurrency(data.totalExpenses, displayCurrency)}
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
            {data.expenseGrowth >= 0 ? (
              <TrendingUp className="h-3 w-3 text-destructive" />
            ) : (
              <TrendingDown className="h-3 w-3 text-success" />
            )}
            <span className={data.expenseGrowth >= 0 ? "text-destructive" : "text-success"}>
              {Math.abs(data.expenseGrowth).toFixed(1)}%
            </span>
            <span>vs last month</span>
          </div>
        </CardContent>
      </Card>

      {/* Categories Count */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Categories</CardDescription>
          <PieChartIcon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.categories.length}</div>
          <p className="text-xs text-muted-foreground mt-1">
            Active expense categories
          </p>
        </CardContent>
      </Card>

      {/* Top Category */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Top Category</CardDescription>
          <Receipt className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {data.categories.length > 0 ? (
            <>
              <div className="text-lg font-bold truncate">
                {data.categories[0].name}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {formatCurrency(data.categories[0].amount, displayCurrency)} ({data.categories[0].percentage.toFixed(1)}%)
              </p>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">No data yet</div>
          )}
        </CardContent>
      </Card>

      {/* Pie Chart */}
      <Card className="md:col-span-1 lg:col-span-1">
        <CardHeader>
          <CardTitle>Distribution</CardTitle>
          <CardDescription>By category</CardDescription>
        </CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value, displayCurrency)}
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
            <div className="flex items-center justify-center h-[250px] text-muted-foreground">
              No expense data yet
            </div>
          )}
        </CardContent>
      </Card>

      {/* Category Breakdown */}
      <Card className="md:col-span-1 lg:col-span-2">
        <CardHeader>
          <CardTitle>Category Breakdown</CardTitle>
          <CardDescription>Expenses by category</CardDescription>
        </CardHeader>
        <CardContent>
          {data.categories.length > 0 ? (
            <div className="space-y-4">
              {data.categories.map((category) => (
                <div key={category.name} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <div 
                        className="w-3 h-3 rounded-full" 
                        style={{ backgroundColor: category.color }}
                      />
                      <span className="font-medium truncate max-w-[150px]">{category.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {category.percentage.toFixed(1)}%
                      </span>
                      <span className="font-medium">
                        {formatCurrency(category.amount, displayCurrency)}
                      </span>
                    </div>
                  </div>
                  <Progress 
                    value={category.percentage} 
                    className="h-2"
                    style={{ 
                      // @ts-ignore
                      '--progress-background': category.color 
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              No expense data yet. Record expenses to see breakdown.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
