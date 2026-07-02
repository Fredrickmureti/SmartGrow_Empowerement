import { useMemo, forwardRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { BarChart2, PieChart, LineChart } from "lucide-react";
import {
  BarChart,
  Bar,
  PieChart as RechartsPie,
  Pie,
  Cell,
  LineChart as RechartsLine,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

export type ChartType = "bar" | "pie" | "line";

interface ReportChartsProps {
  title: string;
  description?: string;
  chartType: ChartType;
  onChartTypeChange: (type: ChartType) => void;
  data: Array<{ name: string; value: number; color?: string }>;
  formatValue: (value: number) => string;
  currencySymbol?: string;
  chartId?: string;
}

const COLORS = [
  "hsl(var(--primary))",
  "hsl(142, 76%, 36%)",
  "hsl(0, 84%, 60%)",
  "hsl(45, 93%, 47%)",
  "hsl(262, 83%, 58%)",
  "hsl(199, 89%, 48%)",
  "hsl(328, 85%, 46%)",
  "hsl(173, 80%, 40%)",
];

export const ReportCharts = forwardRef<HTMLDivElement, ReportChartsProps>(({
  title,
  description,
  chartType,
  onChartTypeChange,
  data,
  formatValue,
  currencySymbol = "$",
  chartId,
}, ref) => {
  const chartData = useMemo(() => 
    data.map((item, i) => ({
      ...item,
      color: item.color || COLORS[i % COLORS.length],
    })),
    [data]
  );

  const total = useMemo(() => 
    chartData.reduce((sum, item) => sum + item.value, 0),
    [chartData]
  );

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="flex items-center justify-center h-64 text-muted-foreground">
          No data available for this period
        </CardContent>
      </Card>
    );
  }

  return (
    <Card ref={ref} id={chartId}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        <ToggleGroup type="single" value={chartType} onValueChange={(v) => v && onChartTypeChange(v as ChartType)}>
          <ToggleGroupItem value="bar" aria-label="Bar Chart" size="sm">
            <BarChart2 className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="pie" aria-label="Pie Chart" size="sm">
            <PieChart className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="line" aria-label="Line Chart" size="sm">
            <LineChart className="h-4 w-4" />
          </ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            {chartType === "bar" ? (
              <BarChart data={chartData} layout="vertical" margin={{ left: 80, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  type="number" 
                  tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`}
                  className="text-xs"
                />
                <YAxis 
                  type="category" 
                  dataKey="name" 
                  width={75}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip 
                  formatter={(value: number) => formatValue(value)}
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                  }}
                />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            ) : chartType === "pie" ? (
              <RechartsPie>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  outerRadius={100}
                  innerRadius={40}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => formatValue(value)}
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                  }}
                />
                <Legend />
              </RechartsPie>
            ) : (
              <RechartsLine data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis 
                  tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`}
                  className="text-xs"
                />
                <Tooltip 
                  formatter={(value: number) => formatValue(value)}
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                  }}
                />
                <Line 
                  type="monotone" 
                  dataKey="value" 
                  stroke="hsl(var(--primary))" 
                  strokeWidth={2}
                  dot={{ fill: "hsl(var(--primary))", strokeWidth: 2 }}
                />
              </RechartsLine>
            )}
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
});

ReportCharts.displayName = "ReportCharts";