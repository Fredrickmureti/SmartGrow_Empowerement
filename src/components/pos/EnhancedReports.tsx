import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { usePOSEnhancedReports } from "@/hooks/pos/usePOSEnhancedReports";
import { useCurrency } from "@/hooks/useCurrency";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { 
  User, 
  AlertTriangle, 
  TrendingUp, 
  Users,
  Award,
  ShoppingBag,
  CreditCard,
  Receipt
} from "lucide-react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

const COLORS = ['hsl(var(--primary))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

interface ReportFilterProps {
  dateFrom?: string;
  dateTo?: string;
  registerId?: string;
}

export function CashierPerformanceReport({ dateFrom, dateTo, registerId }: ReportFilterProps) {
  const { cashierPerformance, isCashierLoading } = usePOSEnhancedReports({ dateFrom, dateTo, registerId });
  const { formatCurrency } = useCurrency();

  if (isCashierLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><User className="h-5 w-5" />Cashier Performance</CardTitle>
        </CardHeader>
        <CardContent><div className="h-48 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><User className="h-5 w-5" />Cashier Performance</CardTitle>
        <CardDescription>Sales and activity metrics by cashier</CardDescription>
      </CardHeader>
      <CardContent>
        {cashierPerformance.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No cashier data available</div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cashier</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="text-right">Txns</TableHead>
                  <TableHead className="text-right">Avg. Sale</TableHead>
                  <TableHead className="text-right">Returns</TableHead>
                  <TableHead className="text-right">Voids</TableHead>
                  <TableHead className="text-right">Cash +/-</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cashierPerformance.map((cashier) => (
                  <TableRow key={cashier.user_id}>
                    <TableCell className="font-medium">{cashier.user_email}</TableCell>
                    <TableCell className="text-right">{formatCurrency(cashier.total_sales)}</TableCell>
                    <TableCell className="text-right">{cashier.transaction_count}</TableCell>
                    <TableCell className="text-right">{formatCurrency(cashier.avg_transaction)}</TableCell>
                    <TableCell className="text-right">
                      {cashier.returns_count > 0 ? <span className="text-amber-600">{cashier.returns_count}</span> : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {cashier.void_count > 0 ? <span className="text-red-600">{cashier.void_count}</span> : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={cashier.cash_over_short >= 0 ? "text-green-600" : "text-red-600"}>
                        {cashier.cash_over_short >= 0 ? "+" : ""}{formatCurrency(cashier.cash_over_short)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FraudDetectionReport({ dateFrom, dateTo, registerId }: ReportFilterProps) {
  const { fraudIndicators, isFraudLoading } = usePOSEnhancedReports({ dateFrom, dateTo, registerId });
  const { formatCurrency } = useCurrency();

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "high": return "destructive";
      case "medium": return "secondary";
      default: return "outline";
    }
  };

  if (isFraudLoading) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5" />Fraud Detection</CardTitle></CardHeader>
        <CardContent><div className="h-48 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5" />Fraud Detection Alerts</CardTitle>
        <CardDescription>Unusual patterns and potential issues</CardDescription>
      </CardHeader>
      <CardContent>
        {fraudIndicators.length === 0 ? (
          <div className="text-center py-8 text-green-600">
            <Award className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>No suspicious activity detected</p>
          </div>
        ) : (
          <div className="space-y-4">
            {fraudIndicators.map((indicator, idx) => (
              <div key={idx} className="flex items-start gap-4 p-4 border rounded-lg">
                <Badge variant={getSeverityColor(indicator.severity) as "default" | "destructive" | "secondary" | "outline"}>
                  {indicator.severity.toUpperCase()}
                </Badge>
                <div className="flex-1">
                  <p className="font-medium">{indicator.user_email}</p>
                  <p className="text-sm text-muted-foreground">{indicator.description}</p>
                  <p className="text-sm mt-1">
                    <span className="font-medium">{indicator.count}</span> occurrences • 
                    <span className="font-medium ml-1">{formatCurrency(indicator.amount)}</span> total
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ABCAnalysisReport({ dateFrom, dateTo, registerId }: ReportFilterProps) {
  const { abcAnalysis, isABCLoading } = usePOSEnhancedReports({ dateFrom, dateTo, registerId });
  const { formatCurrency } = useCurrency();

  const categoryCounts = {
    A: abcAnalysis.filter(p => p.category === "A").length,
    B: abcAnalysis.filter(p => p.category === "B").length,
    C: abcAnalysis.filter(p => p.category === "C").length,
  };

  if (isABCLoading) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5" />ABC Analysis</CardTitle></CardHeader>
        <CardContent><div className="h-48 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5" />ABC Analysis</CardTitle>
        <CardDescription>Product classification by revenue contribution</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="text-center p-4 bg-green-50 dark:bg-green-950 rounded-lg">
            <div className="text-2xl font-bold text-green-600">{categoryCounts.A}</div>
            <div className="text-sm text-muted-foreground">A Items (80%)</div>
          </div>
          <div className="text-center p-4 bg-amber-50 dark:bg-amber-950 rounded-lg">
            <div className="text-2xl font-bold text-amber-600">{categoryCounts.B}</div>
            <div className="text-sm text-muted-foreground">B Items (15%)</div>
          </div>
          <div className="text-center p-4 bg-red-50 dark:bg-red-950 rounded-lg">
            <div className="text-2xl font-bold text-red-600">{categoryCounts.C}</div>
            <div className="text-sm text-muted-foreground">C Items (5%)</div>
          </div>
        </div>
        <div className="space-y-3">
          <h4 className="font-medium">Top A Products</h4>
          {abcAnalysis.filter(p => p.category === "A").slice(0, 10).map((product) => (
            <div key={product.id} className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{product.name}</p>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{product.quantity} units</span>
                  <span>•</span>
                  <span>{product.revenue_percent.toFixed(1)}%</span>
                </div>
              </div>
              <div className="text-right">
                <p className="font-semibold">{formatCurrency(product.revenue)}</p>
                <Progress value={product.revenue_percent} className="w-20 h-1 mt-1" />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function CustomerAnalyticsReport({ dateFrom, dateTo, registerId }: ReportFilterProps) {
  const { customerAnalytics, isCustomerLoading } = usePOSEnhancedReports({ dateFrom, dateTo, registerId });
  const { formatCurrency } = useCurrency();

  if (isCustomerLoading || !customerAnalytics) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" />Customer Analytics</CardTitle></CardHeader>
        <CardContent><div className="h-48 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" />Customer Analytics</CardTitle>
        <CardDescription>Customer behavior and purchasing patterns</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className="text-xl font-bold">{customerAnalytics.total_customers}</div>
            <div className="text-xs text-muted-foreground">Total Customers</div>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className="text-xl font-bold text-green-600">+{customerAnalytics.new_customers}</div>
            <div className="text-xs text-muted-foreground">New Customers</div>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className="text-xl font-bold">{formatCurrency(customerAnalytics.avg_basket_size)}</div>
            <div className="text-xs text-muted-foreground">Avg Basket</div>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className="text-xl font-bold">{customerAnalytics.avg_visits_per_customer.toFixed(1)}</div>
            <div className="text-xs text-muted-foreground">Avg Visits</div>
          </div>
        </div>
        <div className="space-y-3">
          <h4 className="font-medium flex items-center gap-2"><ShoppingBag className="h-4 w-4" />Top Customers</h4>
          {customerAnalytics.top_customers.length === 0 ? (
            <div className="text-center py-4 text-muted-foreground">No customer data available</div>
          ) : (
            customerAnalytics.top_customers.slice(0, 5).map((customer, idx) => (
              <div key={customer.contact_id} className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium">{idx + 1}</div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{customer.name}</p>
                  <p className="text-sm text-muted-foreground">{customer.visit_count} visits • {formatCurrency(customer.avg_basket)} avg</p>
                </div>
                <div className="font-semibold">{formatCurrency(customer.total_spent)}</div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function PaymentBreakdownReport({ dateFrom, dateTo, registerId }: ReportFilterProps) {
  const { paymentBreakdown, isPaymentLoading } = usePOSEnhancedReports({ dateFrom, dateTo, registerId });
  const { formatCurrency } = useCurrency();

  const pieData = paymentBreakdown.map((p, i) => ({
    name: p.payment_method.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
    value: p.total_amount,
    fill: COLORS[i % COLORS.length],
  }));

  if (isPaymentLoading) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5" />Payment Methods</CardTitle></CardHeader>
        <CardContent><div className="h-48 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div></CardContent>
      </Card>
    );
  }

  const grandTotal = paymentBreakdown.reduce((s, p) => s + p.total_amount, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5" />Payment Method Breakdown</CardTitle>
        <CardDescription>Sales split by payment method</CardDescription>
      </CardHeader>
      <CardContent>
        {paymentBreakdown.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No payment data available</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={90} paddingAngle={2} dataKey="value">
                    {pieData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2 mt-2">
                {pieData.map((item, i) => (
                  <div key={item.name} className="flex items-center gap-2 text-sm">
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                    <span className="flex-1">{item.name}</span>
                    <span className="font-medium">{formatCurrency(item.value)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Txns</TableHead>
                    <TableHead className="text-right">%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paymentBreakdown.map((p) => (
                    <TableRow key={p.payment_method}>
                      <TableCell className="font-medium">{p.payment_method.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</TableCell>
                      <TableCell className="text-right">{formatCurrency(p.total_amount)}</TableCell>
                      <TableCell className="text-right">{p.transaction_count}</TableCell>
                      <TableCell className="text-right">{p.percentage.toFixed(1)}%</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-bold border-t-2">
                    <TableCell>Total</TableCell>
                    <TableCell className="text-right">{formatCurrency(grandTotal)}</TableCell>
                    <TableCell className="text-right">{paymentBreakdown.reduce((s, p) => s + p.transaction_count, 0)}</TableCell>
                    <TableCell className="text-right">100%</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function TaxSummaryReport({ dateFrom, dateTo, registerId }: ReportFilterProps) {
  const { taxSummary, isTaxLoading } = usePOSEnhancedReports({ dateFrom, dateTo, registerId });
  const { formatCurrency } = useCurrency();

  if (isTaxLoading) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Receipt className="h-5 w-5" />Tax Summary</CardTitle></CardHeader>
        <CardContent><div className="h-48 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div></CardContent>
      </Card>
    );
  }

  const totalTax = taxSummary.reduce((s, t) => s + t.tax_amount, 0);
  const totalTaxable = taxSummary.reduce((s, t) => s + t.taxable_amount, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Receipt className="h-5 w-5" />Tax Summary</CardTitle>
        <CardDescription>Collected tax by rate</CardDescription>
      </CardHeader>
      <CardContent>
        {taxSummary.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No tax data available</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-xl font-bold">{formatCurrency(totalTaxable)}</div>
                <div className="text-xs text-muted-foreground">Total Taxable Sales</div>
              </div>
              <div className="text-center p-4 bg-primary/10 rounded-lg">
                <div className="text-xl font-bold text-primary">{formatCurrency(totalTax)}</div>
                <div className="text-xs text-muted-foreground">Total Tax Collected</div>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tax Rate</TableHead>
                  <TableHead className="text-right">Taxable Amount</TableHead>
                  <TableHead className="text-right">Tax Collected</TableHead>
                  <TableHead className="text-right">Line Items</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {taxSummary.map((t) => (
                  <TableRow key={t.tax_rate}>
                    <TableCell className="font-medium">{t.tax_rate}%</TableCell>
                    <TableCell className="text-right">{formatCurrency(t.taxable_amount)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(t.tax_amount)}</TableCell>
                    <TableCell className="text-right">{t.transaction_count}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-bold border-t-2">
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right">{formatCurrency(totalTaxable)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(totalTax)}</TableCell>
                  <TableCell className="text-right">{taxSummary.reduce((s, t) => s + t.transaction_count, 0)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
