/**
 * ManageBudgetSheet — read/manage view for a Budget. Shows variance
 * summary, line items with actuals, chart, and lets the user calculate
 * actuals or add items. Mounted on the widest DetailSheet size to keep
 * the interaction language consistent with the rest of Finance while
 * accommodating the item table + chart tabs.
 *
 * URL-driven behind `?sheet=manage&id=<uuid>`.
 */
import { useMemo } from "react";
import {
  AlertTriangle,
  Loader2,
  Plus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  DetailSheet,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { type Budget, type BudgetItem } from "@/hooks/useBudgets";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { useBudgetVsActual } from "@/hooks/useBudgetVsActual";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget: Budget | null;
  onAddItem: () => void;
}

export function ManageBudgetSheet({
  open,
  onOpenChange,
  budget,
  onAddItem,
}: Props) {
  const { accounts } = useAccounts();
  const { formatCurrency } = useCurrency();
  const {
    storedActuals,
    calculateActuals,
    getChartData,
    selectedBudget: bvaBudget,
    getVarianceReport,
  } = useBudgetVsActual(budget?.id);

  const items: BudgetItem[] = budget?.items || [];

  const getAccountName = (accountId: string) => {
    const account = accounts.find((a) => a.id === accountId);
    return account ? `${account.code} - ${account.name}` : "Unknown Account";
  };

  const getActualForItem = (accountId: string, month: number): number =>
    storedActuals
      .filter((a) => a.account_id === accountId && a.period_month === month)
      .reduce((sum, a) => sum + a.actual_amount, 0);

  const chartData = useMemo(() => {
    if (!budget) return [];
    const cd = bvaBudget ? getChartData(budget) : null;
    if (cd) return cd;
    return MONTHS.map((month, index) => {
      const monthItems = items.filter((item) => item.period_month === index + 1);
      const total = monthItems.reduce((sum, i) => sum + i.budgeted_amount, 0);
      const monthActuals = storedActuals.filter(
        (a) => a.period_month === index + 1,
      );
      const actual = monthActuals.reduce((sum, a) => sum + a.actual_amount, 0);
      return {
        month: month.substring(0, 3),
        budgeted: total,
        actual,
        variance: total - actual,
      };
    });
  }, [budget, bvaBudget, items, storedActuals, getChartData]);

  const varianceReport = budget ? getVarianceReport(budget) : null;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "active":
        return <Badge className="bg-primary/10 text-primary">Active</Badge>;
      case "closed":
        return <Badge variant="secondary">Closed</Badge>;
      default:
        return <Badge variant="outline">Draft</Badge>;
    }
  };

  if (!budget) return null;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          {budget.name}
          {getStatusBadge(budget.status)}
        </span>
      }
      description={
        <>
          Fiscal Year {budget.fiscal_year}
          {budget.status === "closed" && " • This budget is closed and read-only."}
        </>
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button
                variant="outline"
                onClick={() => calculateActuals.mutateAsync(budget)}
                disabled={calculateActuals.isPending}
              >
                {calculateActuals.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Calculate actuals
              </Button>
              {budget.status !== "closed" && (
                <Button onClick={onAddItem}>
                  <Plus className="mr-2 h-4 w-4" /> Add item
                </Button>
              )}
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <div className="space-y-4">
        {varianceReport && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Total Budgeted</p>
              <p className="text-lg font-bold">
                {formatCurrency(varianceReport.totalBudgeted)}
              </p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Total Actual</p>
              <p className="text-lg font-bold">
                {formatCurrency(varianceReport.totalActual)}
              </p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Variance</p>
              <p
                className={`text-lg font-bold ${
                  varianceReport.totalVariance >= 0
                    ? "text-primary"
                    : "text-destructive"
                }`}
              >
                {formatCurrency(varianceReport.totalVariance)}
              </p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Variance %</p>
              <p
                className={`text-lg font-bold ${
                  varianceReport.variancePercent >= 0
                    ? "text-primary"
                    : "text-destructive"
                }`}
              >
                {varianceReport.variancePercent.toFixed(1)}%
              </p>
            </Card>
          </div>
        )}

        <Tabs defaultValue="items" className="space-y-4">
          <TabsList>
            <TabsTrigger value="items">Budget items</TabsTrigger>
            <TabsTrigger value="chart">Chart view</TabsTrigger>
          </TabsList>

          <TabsContent value="items" className="space-y-4">
            {items.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No budget items yet. Add items to start planning.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Budgeted</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...items]
                    .sort((a, b) => a.period_month - b.period_month)
                    .map((item) => {
                      const actual = getActualForItem(
                        item.account_id,
                        item.period_month,
                      );
                      const variance = item.budgeted_amount - actual;
                      const hasActual = storedActuals.length > 0;
                      return (
                        <TableRow key={item.id}>
                          <TableCell>{getAccountName(item.account_id)}</TableCell>
                          <TableCell>{MONTHS[item.period_month - 1]}</TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(item.budgeted_amount)}
                          </TableCell>
                          <TableCell className="text-right">
                            {hasActual ? (
                              formatCurrency(actual)
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell
                            className={`text-right font-medium ${
                              hasActual
                                ? variance >= 0
                                  ? "text-primary"
                                  : "text-destructive"
                                : ""
                            }`}
                          >
                            {hasActual ? (
                              <span className="flex items-center justify-end gap-1">
                                {variance > 0 && (
                                  <TrendingDown className="h-3 w-3" />
                                )}
                                {variance < 0 && (
                                  <TrendingUp className="h-3 w-3" />
                                )}
                                {formatCurrency(variance)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground truncate max-w-xs">
                            {item.notes || "-"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            )}

            {storedActuals.length === 0 && items.length > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Click "Calculate actuals" to pull real GL data and compare
                  against budget.
                </AlertDescription>
              </Alert>
            )}
          </TabsContent>

          <TabsContent value="chart">
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-muted"
                  />
                  <XAxis dataKey="month" />
                  <YAxis />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                  />
                  <Legend />
                  <Bar
                    dataKey="budgeted"
                    fill="hsl(var(--primary))"
                    name="Budgeted"
                  />
                  <Bar
                    dataKey="actual"
                    fill="hsl(var(--accent-foreground))"
                    name="Actual"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </DetailSheet>
  );
}

export default ManageBudgetSheet;
