import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  ArrowUpRight,
  ArrowDownRight,
  Building2,
  Banknote,
  CreditCard,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface CashFlowData {
  invoices: Array<{
    id: string;
    total: number;
    amount_paid: number;
    status: string;
    issue_date: string;
    paid_at?: string;
  }>;
  bills: Array<{
    id: string;
    total: number;
    amount_paid: number;
    status: string;
    bill_date: string;
  }>;
  expenses: Array<{
    id: string;
    amount: number;
    status: string;
    expense_date: string;
    category?: string;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    payment_date: string;
    invoice_id?: string;
  }>;
  billPayments: Array<{
    id: string;
    amount: number;
    payment_date: string;
    bill_id?: string;
  }>;
  dateRange: {
    start: Date;
    end: Date;
  };
  formatCurrency: (amount: number) => string;
  previousPeriodData?: {
    operatingCashFlow: number;
    investingCashFlow: number;
    financingCashFlow: number;
  };
}

interface CashFlowStatementProps {
  data: CashFlowData;
  showComparison?: boolean;
}

export function CashFlowStatement({ data, showComparison = false }: CashFlowStatementProps) {
  const { invoices, bills, expenses, payments, billPayments, dateRange, formatCurrency, previousPeriodData } = data;

  const cashFlow = useMemo(() => {
    // Operating Activities
    // Cash received from customers (payments on invoices)
    const cashFromCustomers = payments
      .filter((p) => {
        const paymentDate = new Date(p.payment_date);
        return paymentDate >= dateRange.start && paymentDate <= dateRange.end;
      })
      .reduce((sum, p) => sum + p.amount, 0);

    // Cash paid to suppliers (bill payments)
    const cashToSuppliers = billPayments
      .filter((p) => {
        const paymentDate = new Date(p.payment_date);
        return paymentDate >= dateRange.start && paymentDate <= dateRange.end;
      })
      .reduce((sum, p) => sum + p.amount, 0);

    // Cash paid for operating expenses (cash flow = only actually paid expenses)
    const cashForExpenses = expenses
      .filter((e) => {
        const expenseDate = new Date(e.expense_date);
        return (
          expenseDate >= dateRange.start &&
          expenseDate <= dateRange.end &&
          e.status === "paid"
        );
      })
      .reduce((sum, e) => sum + e.amount, 0);

    // Break down expenses by category (cash flow = only paid)
    const expensesByCategory = expenses
      .filter((e) => {
        const expenseDate = new Date(e.expense_date);
        return (
          expenseDate >= dateRange.start &&
          expenseDate <= dateRange.end &&
          e.status === "paid"
        );
      })
      .reduce((acc, e) => {
        const category = e.category || "Other";
        acc[category] = (acc[category] || 0) + e.amount;
        return acc;
      }, {} as Record<string, number>);

    const operatingCashFlow = cashFromCustomers - cashToSuppliers - cashForExpenses;

    // Investing Activities (simplified - would need asset purchases/sales data)
    // For now, we'll show placeholders
    const investingCashFlow = 0; // Would calculate from fixed asset transactions

    // Financing Activities (simplified - would need loan/equity data)
    const financingCashFlow = 0; // Would calculate from loan payments, equity injections

    const netCashFlow = operatingCashFlow + investingCashFlow + financingCashFlow;

    return {
      operating: {
        cashFromCustomers,
        cashToSuppliers,
        cashForExpenses,
        expensesByCategory,
        netOperating: operatingCashFlow,
      },
      investing: {
        assetPurchases: 0,
        assetSales: 0,
        netInvesting: investingCashFlow,
      },
      financing: {
        loanProceeds: 0,
        loanRepayments: 0,
        dividendsPaid: 0,
        netFinancing: financingCashFlow,
      },
      netCashFlow,
      previousPeriod: previousPeriodData,
    };
  }, [invoices, bills, expenses, payments, billPayments, dateRange, previousPeriodData]);

  const getChangePercent = (current: number, previous: number | undefined): number | null => {
    if (!previous || previous === 0) return null;
    return ((current - previous) / Math.abs(previous)) * 100;
  };

  const renderAmount = (amount: number, isNegative = false) => {
    const value = isNegative ? -amount : amount;
    const isPositive = value >= 0;
    return (
      <span className={cn("font-medium", isPositive ? "text-green-600" : "text-red-600")}>
        {isPositive && value > 0 && "+"}
        {formatCurrency(value)}
      </span>
    );
  };

  const renderLineItem = (
    label: string,
    amount: number,
    isSubtraction = false,
    indent = false
  ) => (
    <div className={cn("flex justify-between py-1", indent && "pl-4")}>
      <span className={cn("text-sm", indent ? "text-muted-foreground" : "")}>
        {isSubtraction && "Less: "}
        {label}
      </span>
      <span className={cn("text-sm font-medium", isSubtraction && "text-red-600")}>
        {isSubtraction ? `(${formatCurrency(amount)})` : formatCurrency(amount)}
      </span>
    </div>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Banknote className="h-5 w-5 text-primary" />
              <CardTitle>Cash Flow Statement</CardTitle>
            </div>
            <Badge variant="outline">
              {dateRange.start.toLocaleDateString()} - {dateRange.end.toLocaleDateString()}
            </Badge>
          </div>
          <CardDescription>
            Summary of cash inflows and outflows for the period
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Operating Activities */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-blue-600" />
            <CardTitle className="text-base">Cash Flows from Operating Activities</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {renderLineItem("Cash received from customers", cashFlow.operating.cashFromCustomers)}
          {renderLineItem("Cash paid to suppliers", cashFlow.operating.cashToSuppliers, true)}
          
          {Object.entries(cashFlow.operating.expensesByCategory).length > 0 && (
            <>
              <div className="text-sm font-medium pt-2">Operating expenses paid:</div>
              {Object.entries(cashFlow.operating.expensesByCategory)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([category, amount]) => (
                  <div key={category} className="flex justify-between py-1 pl-4">
                    <span className="text-sm text-muted-foreground">{category}</span>
                    <span className="text-sm text-red-600">({formatCurrency(amount)})</span>
                  </div>
                ))}
              {Object.entries(cashFlow.operating.expensesByCategory).length > 5 && (
                <div className="flex justify-between py-1 pl-4">
                  <span className="text-sm text-muted-foreground">Other expenses</span>
                  <span className="text-sm text-red-600">
                    ({formatCurrency(
                      Object.entries(cashFlow.operating.expensesByCategory)
                        .slice(5)
                        .reduce((sum, [, amount]) => sum + amount, 0)
                    )})
                  </span>
                </div>
              )}
            </>
          )}

          <Separator className="my-2" />
          
          <div className="flex justify-between py-2">
            <span className="font-semibold">Net Cash from Operating Activities</span>
            <div className="flex items-center gap-2">
              {renderAmount(cashFlow.operating.netOperating)}
              {showComparison && previousPeriodData && (
                <ChangeIndicator
                  change={getChangePercent(
                    cashFlow.operating.netOperating,
                    previousPeriodData.operatingCashFlow
                  )}
                />
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Investing Activities */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-purple-600" />
            <CardTitle className="text-base">Cash Flows from Investing Activities</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {cashFlow.investing.assetPurchases > 0 &&
            renderLineItem("Purchase of fixed assets", cashFlow.investing.assetPurchases, true)}
          {cashFlow.investing.assetSales > 0 &&
            renderLineItem("Proceeds from asset sales", cashFlow.investing.assetSales)}
          
          {cashFlow.investing.netInvesting === 0 && (
            <div className="text-sm text-muted-foreground italic py-2">
              No investing activities recorded for this period
            </div>
          )}

          <Separator className="my-2" />
          
          <div className="flex justify-between py-2">
            <span className="font-semibold">Net Cash from Investing Activities</span>
            {renderAmount(cashFlow.investing.netInvesting)}
          </div>
        </CardContent>
      </Card>

      {/* Financing Activities */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-orange-600" />
            <CardTitle className="text-base">Cash Flows from Financing Activities</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {cashFlow.financing.loanProceeds > 0 &&
            renderLineItem("Proceeds from borrowings", cashFlow.financing.loanProceeds)}
          {cashFlow.financing.loanRepayments > 0 &&
            renderLineItem("Repayment of borrowings", cashFlow.financing.loanRepayments, true)}
          {cashFlow.financing.dividendsPaid > 0 &&
            renderLineItem("Dividends paid", cashFlow.financing.dividendsPaid, true)}

          {cashFlow.financing.netFinancing === 0 && (
            <div className="text-sm text-muted-foreground italic py-2">
              No financing activities recorded for this period
            </div>
          )}

          <Separator className="my-2" />
          
          <div className="flex justify-between py-2">
            <span className="font-semibold">Net Cash from Financing Activities</span>
            {renderAmount(cashFlow.financing.netFinancing)}
          </div>
        </CardContent>
      </Card>

      {/* Net Cash Flow Summary */}
      <Card className="border-2 border-primary/20 bg-primary/5">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={cn(
                "p-3 rounded-full",
                cashFlow.netCashFlow >= 0 ? "bg-green-100" : "bg-red-100"
              )}>
                {cashFlow.netCashFlow >= 0 ? (
                  <ArrowUpRight className="h-6 w-6 text-green-600" />
                ) : (
                  <ArrowDownRight className="h-6 w-6 text-red-600" />
                )}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Net Increase/(Decrease) in Cash</p>
                <p className="text-2xl font-bold">
                  {renderAmount(cashFlow.netCashFlow)}
                </p>
              </div>
            </div>
            
            <div className="text-right space-y-1">
              <div className="text-xs text-muted-foreground">Breakdown</div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Operating:</span>
                {renderAmount(cashFlow.operating.netOperating)}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Investing:</span>
                {renderAmount(cashFlow.investing.netInvesting)}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Financing:</span>
                {renderAmount(cashFlow.financing.netFinancing)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ChangeIndicator({ change }: { change: number | null }) {
  if (change === null) return null;
  
  const isPositive = change >= 0;
  return (
    <Badge variant={isPositive ? "default" : "destructive"} className="text-xs">
      {isPositive ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
      {Math.abs(change).toFixed(1)}%
    </Badge>
  );
}
