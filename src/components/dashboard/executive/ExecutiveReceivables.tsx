import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, AlertTriangle } from "lucide-react";
import type { ReceivablesData, PayablesData } from "@/hooks/useDashboardAnalytics";
import type { TopDebtor } from "@/hooks/useExecutiveStats";
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

interface ExecutiveReceivablesProps {
  receivables: ReceivablesData | null;
  payables: PayablesData | null;
  dso: number;
  collectionRate: number;
  topDebtors: TopDebtor[];
  displayAmount: (amount: number) => string;
  currencySymbol: string;
}

export function ExecutiveReceivables({
  receivables,
  payables,
  dso,
  collectionRate,
  topDebtors,
  displayAmount,
  currencySymbol,
}: ExecutiveReceivablesProps) {
  // Canonical aging vocabulary (see src/services/finance/aging.ts): the labels
  // must match the SQL bucket boundaries, not a shifted copy of them.
  const agingData = [
    {
      bucket: "Not yet due",
      receivables: receivables?.notDue || 0,
      payables: payables?.notDue || 0,
    },
    {
      bucket: "0-30 days",
      receivables: receivables?.current || 0,
      payables: payables?.current || 0,
    },
    {
      bucket: "31-60 days",
      receivables: receivables?.days30 || 0,
      payables: payables?.days30 || 0,
    },
    {
      bucket: "61-90 days",
      receivables: receivables?.days60 || 0,
      payables: payables?.days60 || 0,
    },
    {
      bucket: "90+ days",
      receivables: receivables?.days90 || 0,
      payables: payables?.days90 || 0,
    },
  ];


  const hasAgingData = agingData.some(d => d.receivables > 0 || d.payables > 0);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Summary cards */}
      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Total AR</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-warning">
              {displayAmount(receivables?.totalReceivables || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Total AP</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-destructive">
              {displayAmount(payables?.totalPayables || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">DSO</CardDescription>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{dso.toFixed(0)} days</div>
            <p className="text-xs text-muted-foreground mt-1">Days Sales Outstanding</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="text-xs">Collection Rate</CardDescription>
          </CardHeader>
          <CardContent>
            <div className={`text-xl font-bold ${collectionRate >= 80 ? "text-success" : collectionRate >= 50 ? "text-warning" : "text-destructive"}`}>
              {collectionRate.toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground mt-1">Invoices collected</p>
          </CardContent>
        </Card>
      </div>

      {/* Aging Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base sm:text-lg">AR / AP Aging</CardTitle>
          <CardDescription>Receivables vs payables by aging bucket</CardDescription>
        </CardHeader>
        <CardContent>
          {hasAgingData ? (
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={agingData} margin={{ left: -10, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
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
                  <Bar dataKey="receivables" fill="hsl(38, 92%, 50%)" name="Receivables" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="payables" fill="hsl(0, 84%, 60%)" name="Payables" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[300px] text-muted-foreground">No aging data yet</div>
          )}
        </CardContent>
      </Card>

      {/* Top Debtors */}
      {topDebtors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base sm:text-lg">Top Debtors</CardTitle>
            <CardDescription>Customers with highest outstanding amounts</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">Customer</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">Business</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Outstanding</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Days Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {topDebtors.map((debtor, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="py-2 px-3 font-medium">{debtor.contactName}</td>
                      <td className="py-2 px-3 text-muted-foreground">{debtor.businessName}</td>
                      <td className="text-right py-2 px-3 font-semibold text-warning">
                        {displayAmount(debtor.amount)}
                      </td>
                      <td className="text-right py-2 px-3">
                        {debtor.daysOverdue > 0 ? (
                          <Badge variant={debtor.daysOverdue > 60 ? "destructive" : debtor.daysOverdue > 30 ? "secondary" : "outline"} className="text-xs">
                            {debtor.daysOverdue}d
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">Current</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
