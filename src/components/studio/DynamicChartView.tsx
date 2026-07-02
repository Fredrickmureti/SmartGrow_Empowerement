import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SavedView } from "@/hooks/useSavedViews";
import { Loader2 } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";

interface ChartConfig {
  chart_type: "bar" | "line" | "pie" | "area";
  x_field: string;
  y_field: string;
  aggregation?: "sum" | "count" | "avg";
  colors?: string[];
}

interface DynamicChartViewProps<T extends Record<string, unknown>> {
  view: SavedView;
  data: T[];
  isLoading?: boolean;
  height?: number;
}

const DEFAULT_COLORS = ["hsl(var(--primary))", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

export function DynamicChartView<T extends Record<string, unknown>>({ view, data, isLoading, height = 350 }: DynamicChartViewProps<T>) {
  const config = view.view_config as unknown as ChartConfig;
  const colors = config?.colors || DEFAULT_COLORS;

  const chartData = useMemo(() => {
    if (!config?.x_field || !config?.y_field) return [];
    const groups: Record<string, number[]> = {};
    data.forEach((item) => {
      const xValue = String(item[config.x_field] ?? "Other");
      const yValue = Number(item[config.y_field]) || 0;
      if (!groups[xValue]) groups[xValue] = [];
      groups[xValue].push(yValue);
    });
    return Object.entries(groups).map(([name, values]) => {
      let value: number;
      switch (config.aggregation) {
        case "count": value = values.length; break;
        case "avg": value = values.reduce((a, b) => a + b, 0) / values.length; break;
        default: value = values.reduce((a, b) => a + b, 0);
      }
      return { name, value: Math.round(value * 100) / 100 };
    });
  }, [data, config]);

  if (isLoading) return <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  if (!config?.x_field) return <Card><CardContent className="py-8 text-center text-muted-foreground">Configure chart fields</CardContent></Card>;

  const renderChart = () => {
    switch (config.chart_type) {
      case "bar":
        return <BarChart data={chartData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" tick={{ fontSize: 12 }} /><YAxis tick={{ fontSize: 12 }} /><Tooltip /><Bar dataKey="value" fill={colors[0]} radius={[4, 4, 0, 0]} /></BarChart>;
      case "line":
        return <LineChart data={chartData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" tick={{ fontSize: 12 }} /><YAxis tick={{ fontSize: 12 }} /><Tooltip /><Line type="monotone" dataKey="value" stroke={colors[0]} strokeWidth={2} /></LineChart>;
      case "pie":
        return <PieChart><Pie data={chartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>{chartData.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}</Pie><Tooltip /><Legend /></PieChart>;
      default:
        return <BarChart data={chartData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" /><YAxis /><Tooltip /><Bar dataKey="value" fill={colors[0]} /></BarChart>;
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-sm">{view.view_name}</CardTitle></CardHeader>
      <CardContent><ResponsiveContainer width="100%" height={height}>{renderChart()}</ResponsiveContainer></CardContent>
    </Card>
  );
}
