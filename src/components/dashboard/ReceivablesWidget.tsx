import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrency } from "@/hooks/useCurrency";
import { AlertTriangle, Clock, CheckCircle, Users, FileText } from "lucide-react";
import { ReceivablesData, PayablesData } from "@/hooks/useDashboardAnalytics";
import { Progress } from "@/components/ui/progress";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface ReceivablesWidgetProps {
  receivables: ReceivablesData;
  payables: PayablesData;
  displayCurrency: string;
}

export function ReceivablesWidget({ receivables, payables, displayCurrency }: ReceivablesWidgetProps) {
  const { formatCurrency } = useCurrency();
  const navigate = useNavigate();

  const agingData = [
    { name: "Current", receivables: receivables.current, payables: payables.current },
    { name: "1-30 days", receivables: receivables.overdue30, payables: payables.overdue30 },
    { name: "31-60 days", receivables: receivables.overdue60, payables: payables.overdue60 },
    { name: "60+ days", receivables: receivables.overdue90, payables: payables.overdue90 },
  ];

  const totalOverdue = receivables.overdue30 + receivables.overdue60 + receivables.overdue90;
  const overduePercentage = receivables.totalReceivables > 0 
    ? (totalOverdue / receivables.totalReceivables) * 100 
    : 0;

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
      {/* Total Receivables */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Total Receivables</CardDescription>
          <FileText className="h-4 w-4 text-primary" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {formatCurrency(receivables.totalReceivables, displayCurrency)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Outstanding from customers
          </p>
        </CardContent>
      </Card>

      {/* Overdue Amount */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Overdue</CardDescription>
          <AlertTriangle className="h-4 w-4 text-destructive" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-destructive">
            {formatCurrency(totalOverdue, displayCurrency)}
          </div>
          <div className="mt-2">
            <Progress value={overduePercentage} className="h-2" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {overduePercentage.toFixed(1)}% of total
          </p>
        </CardContent>
      </Card>

      {/* Total Payables */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Total Payables</CardDescription>
          <Clock className="h-4 w-4 text-warning" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {formatCurrency(payables.totalPayables, displayCurrency)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Outstanding to suppliers
          </p>
        </CardContent>
      </Card>

      {/* Net Position */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription>Net Position</CardDescription>
          <CheckCircle className={`h-4 w-4 ${receivables.totalReceivables - payables.totalPayables >= 0 ? "text-success" : "text-destructive"}`} />
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${receivables.totalReceivables - payables.totalPayables >= 0 ? "text-success" : "text-destructive"}`}>
            {formatCurrency(receivables.totalReceivables - payables.totalPayables, displayCurrency)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Receivables - Payables
          </p>
        </CardContent>
      </Card>

      {/* Aging Chart */}
      <Card className="md:col-span-2 lg:col-span-2">
        <CardHeader>
          <CardTitle>Aging Analysis</CardTitle>
          <CardDescription>Receivables & Payables by age</CardDescription>
        </CardHeader>
        <CardContent>
          {agingData.some(d => d.receivables > 0 || d.payables > 0) ? (
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={agingData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis type="number" className="text-xs" />
                  <YAxis type="category" dataKey="name" className="text-xs" width={80} />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value, displayCurrency)}
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                  />
                  <Bar 
                    dataKey="receivables" 
                    fill="hsl(var(--primary))" 
                    name="Receivables"
                    radius={[0, 4, 4, 0]}
                  />
                  <Bar 
                    dataKey="payables" 
                    fill="hsl(var(--warning))" 
                    name="Payables"
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[250px] text-muted-foreground">
              No aging data yet
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top Debtors */}
      <Card className="md:col-span-2 lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Top Debtors</CardTitle>
            <CardDescription>Customers with highest outstanding</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate("/sales/invoices")}>
            View All
          </Button>
        </CardHeader>
        <CardContent>
          {receivables.topDebtors.length > 0 ? (
            <div className="space-y-4">
              {receivables.topDebtors.map((debtor, index) => (
                <div key={debtor.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                      <Users className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium truncate max-w-[150px]">{debtor.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {debtor.daysOverdue > 0 ? (
                          <span className="text-destructive">{debtor.daysOverdue} days overdue</span>
                        ) : (
                          <span className="text-success">Current</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <p className="font-medium">
                    {formatCurrency(debtor.amount, displayCurrency)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              No outstanding invoices
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
