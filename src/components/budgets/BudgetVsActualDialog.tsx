import { useState } from "react";
import { useBudgetVsActual, BudgetVarianceItem } from "@/hooks/useBudgetVsActual";
import { Budget } from "@/hooks/useBudgets";
import { useCurrency } from "@/hooks/useCurrency";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  Calculator,
  Loader2,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle,
} from "lucide-react";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

interface BudgetVsActualDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget: Budget | null;
}

export function BudgetVsActualDialog({ open, onOpenChange, budget }: BudgetVsActualDialogProps) {
  const { storedActuals, isLoading, calculateActuals, getVarianceReport, getChartData } =
    useBudgetVsActual(budget?.id);
  const { formatCurrency } = useCurrency();
  const [isCalculating, setIsCalculating] = useState(false);
  const [activeTab, setActiveTab] = useState("summary");

  const handleCalculate = async () => {
    if (!budget) return;
    setIsCalculating(true);
    try {
      await calculateActuals.mutateAsync(budget);
    } finally {
      setIsCalculating(false);
    }
  };

  const varianceReport = budget ? getVarianceReport(budget) : null;
  const chartData = budget ? getChartData(budget) : [];

  const getVarianceBadge = (item: BudgetVarianceItem) => {
    if (item.status === "over") {
      return (
        <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
          <TrendingUp className="mr-1 h-3 w-3" />
          Over {Math.abs(item.variancePercent).toFixed(0)}%
        </Badge>
      );
    } else if (item.status === "under") {
      return (
        <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
          <TrendingDown className="mr-1 h-3 w-3" />
          Under {Math.abs(item.variancePercent).toFixed(0)}%
        </Badge>
      );
    }
    return (
      <Badge variant="secondary">
        <CheckCircle className="mr-1 h-3 w-3" />
        On Track
      </Badge>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Budget vs Actual Analysis</DialogTitle>
          <DialogDescription>
            {budget?.name} - Fiscal Year {budget?.fiscal_year}
          </DialogDescription>
        </DialogHeader>

        {/* Summary Cards */}
        {varianceReport && (
          <div className="grid gap-4 md:grid-cols-4 mb-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Total Budgeted</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">
                  {formatCurrency(varianceReport.totalBudgeted)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Total Actual</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">
                  {formatCurrency(varianceReport.totalActual)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Variance</CardTitle>
              </CardHeader>
              <CardContent>
                <div
                  className={`text-xl font-bold ${
                    varianceReport.totalVariance >= 0 ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {formatCurrency(varianceReport.totalVariance)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Variance %</CardTitle>
              </CardHeader>
              <CardContent>
                <div
                  className={`text-xl font-bold ${
                    varianceReport.variancePercent >= 0 ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {varianceReport.variancePercent.toFixed(1)}%
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        <div className="flex justify-end mb-2">
          <Button onClick={handleCalculate} disabled={isCalculating} variant="outline">
            {isCalculating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Calculator className="mr-2 h-4 w-4" />
            )}
            Recalculate Actuals
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="chart">Chart</TabsTrigger>
            <TabsTrigger value="detail">Detail by Account</TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="flex-1 overflow-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : storedActuals.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <AlertTriangle className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No actuals calculated</h3>
                <p className="text-muted-foreground mb-4">
                  Calculate actuals from journal entries to see variance analysis.
                </p>
                <Button onClick={handleCalculate} disabled={isCalculating}>
                  {isCalculating ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Calculator className="mr-2 h-4 w-4" />
                  )}
                  Calculate Actuals
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Budgeted</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {chartData.map((row, index) => {
                    const variance = row.budgeted - row.actual;
                    const variancePercent =
                      row.budgeted > 0 ? (variance / row.budgeted) * 100 : 0;
                    let status: "under" | "over" | "on_track" = "on_track";
                    if (variancePercent < -10) status = "over";
                    else if (variancePercent > 10) status = "under";

                    return (
                      <TableRow key={index}>
                        <TableCell className="font-medium">{row.fullMonth}</TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(row.budgeted)}
                        </TableCell>
                        <TableCell className="text-right">{formatCurrency(row.actual)}</TableCell>
                        <TableCell
                          className={`text-right font-medium ${
                            variance >= 0 ? "text-green-600" : "text-red-600"
                          }`}
                        >
                          {formatCurrency(variance)}
                        </TableCell>
                        <TableCell>
                          {getVarianceBadge({
                            accountId: "",
                            accountCode: "",
                            accountName: "",
                            month: index + 1,
                            budgeted: row.budgeted,
                            actual: row.actual,
                            variance,
                            variancePercent,
                            status,
                          })}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="chart" className="flex-1">
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  formatter={(value: number) => formatCurrency(value)}
                  labelFormatter={(label) => `${label}`}
                />
                <Legend />
                <Bar dataKey="budgeted" fill="hsl(var(--primary))" name="Budgeted" />
                <Bar dataKey="actual" fill="hsl(var(--muted-foreground))" name="Actual" />
              </BarChart>
            </ResponsiveContainer>
          </TabsContent>

          <TabsContent value="detail" className="flex-1 overflow-auto">
            {varianceReport && Array.from(varianceReport.itemsByAccount.entries()).map(([accountId, items]) => (
              <div key={accountId} className="mb-6">
                <h3 className="font-medium mb-2">
                  {items[0]?.accountCode} - {items[0]?.accountName}
                </h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Budgeted</TableHead>
                      <TableHead className="text-right">Actual</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={`${accountId}-${item.month}`}>
                        <TableCell>{MONTHS[item.month - 1]}</TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(item.budgeted)}
                        </TableCell>
                        <TableCell className="text-right">{formatCurrency(item.actual)}</TableCell>
                        <TableCell
                          className={`text-right ${
                            item.variance >= 0 ? "text-green-600" : "text-red-600"
                          }`}
                        >
                          {formatCurrency(item.variance)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
