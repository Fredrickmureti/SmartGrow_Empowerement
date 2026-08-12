import { useDashboardStats } from "@/hooks/useDashboardStats";
import { useDashboardAnalytics } from "@/hooks/useDashboardAnalytics";
import { useExecutiveStats } from "@/hooks/useExecutiveStats";
import { useOrganization } from "@/hooks/useOrganization";
import { useCurrency } from "@/hooks/useCurrency";
import { useViewCurrencyPreference } from "@/hooks/useViewCurrencyPreference";
import { BranchComparisonWidget } from "./BranchComparisonWidget";
import { AIInsightsWidget } from "@/components/ai/AIInsightsWidget";
import { AISuggestionsWidget } from "@/components/ai/AISuggestionsWidget";
import { ExecutiveOverview } from "./executive/ExecutiveOverview";
import { ExecutiveCashFlow } from "./executive/ExecutiveCashFlow";
import { ExecutiveProfitability } from "./executive/ExecutiveProfitability";
import { ExecutiveReceivables } from "./executive/ExecutiveReceivables";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { ScrollableTabsList } from "@/components/ui/scrollable-tabs-list";
import { Loader2, Building2, TrendingUp, TrendingDown } from "lucide-react";

export function ExecutiveDashboard() {
  const { currentOrg } = useOrganization();
  const { stats, isLoading: statsLoading } = useDashboardStats();
  const { analytics, isLoading: analyticsLoading } = useDashboardAnalytics();
  const { stats: execStats, isLoading: execLoading } = useExecutiveStats();
  const { formatCurrency, convertCurrency, baseCurrency, getCurrencySymbol } = useCurrency();
  const { viewCurrency } = useViewCurrencyPreference();

  const displayCurrency = viewCurrency || baseCurrency;
  const displayAmount = (amount: number) => {
    if (displayCurrency !== baseCurrency) {
      const converted = convertCurrency(amount, baseCurrency, displayCurrency);
      // No rate on file: show an honest dash rather than an unconverted number.
      if (converted === null) return "—";
      return formatCurrency(converted, displayCurrency);
    }
    return formatCurrency(amount, baseCurrency);
  };
  const currencySymbol = getCurrencySymbol(displayCurrency);

  const isLoading = statsLoading || analyticsLoading || execLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <h1 className="page-title">Organization Overview</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Performance overview for {currentOrg?.name}
          </p>
        </div>
        <Badge variant="outline" className="text-xs">
          Consolidation
        </Badge>
      </div>

      {/* Tabbed Content */}
      <Tabs defaultValue="overview" className="w-full">
        <ScrollableTabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="performance">Business Performance</TabsTrigger>
          <TabsTrigger value="cashflow">Cash Flow</TabsTrigger>
          <TabsTrigger value="profitability">Profitability</TabsTrigger>
          <TabsTrigger value="receivables">Receivables & Payables</TabsTrigger>
          <TabsTrigger value="insights">AI Insights</TabsTrigger>
        </ScrollableTabsList>

        <TabsContent value="overview">
          <ExecutiveOverview
            stats={stats}
            execStats={execStats}
            displayAmount={displayAmount}
            currencySymbol={currencySymbol}
          />
        </TabsContent>

        <TabsContent value="performance">
          <div className="space-y-4 sm:space-y-6">
            <BranchComparisonWidget />

            {/* Business Health Scorecard */}
            {execStats.businessScorecards.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base sm:text-lg">Business Health Scorecard</CardTitle>
                  <CardDescription>Per-business breakdown with key metrics</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 px-3 font-medium text-muted-foreground">Business</th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">Revenue</th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">Expenses</th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">Profit</th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">Margin</th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">Customers</th>
                          <th className="text-right py-2 px-3 font-medium text-muted-foreground">Outstanding AR</th>
                        </tr>
                      </thead>
                      <tbody>
                        {execStats.businessScorecards.map((biz) => (
                          <tr key={biz.businessId} className="border-b last:border-0 hover:bg-muted/50">
                            <td className="py-2 px-3 font-medium">{biz.businessName}</td>
                            <td className="text-right py-2 px-3 text-success">{displayAmount(biz.revenue)}</td>
                            <td className="text-right py-2 px-3 text-destructive">{displayAmount(biz.expenses)}</td>
                            <td className={`text-right py-2 px-3 font-medium ${biz.profit >= 0 ? "text-success" : "text-destructive"}`}>
                              {displayAmount(biz.profit)}
                            </td>
                            <td className="text-right py-2 px-3">
                              <span className={`inline-flex items-center gap-1 ${biz.margin >= 0 ? "text-success" : "text-destructive"}`}>
                                {biz.margin >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                                {biz.margin.toFixed(1)}%
                              </span>
                            </td>
                            <td className="text-right py-2 px-3">{biz.customerCount}</td>
                            <td className="text-right py-2 px-3 text-warning">{displayAmount(biz.outstandingAR)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="cashflow">
          <ExecutiveCashFlow
            cashFlow={analytics?.cashFlow || null}
            cashPosition={execStats.cashPosition}
            bankBalances={analytics?.bankBalances || []}
            displayAmount={displayAmount}
            currencySymbol={currencySymbol}
          />
        </TabsContent>

        <TabsContent value="profitability">
          <ExecutiveProfitability
            profitMargin={analytics?.profitMargin || null}
            expenseCategories={analytics?.expenseCategories || null}
            employeeCount={execStats.employeeCount}
            revenuePerEmployee={execStats.revenuePerEmployee}
            displayAmount={displayAmount}
          />
        </TabsContent>

        <TabsContent value="receivables">
          <ExecutiveReceivables
            receivables={analytics?.receivables || null}
            payables={analytics?.payables || null}
            dso={execStats.dso}
            collectionRate={execStats.collectionRate}
            topDebtors={execStats.topDebtors}
            displayAmount={displayAmount}
            currencySymbol={currencySymbol}
          />
        </TabsContent>

        <TabsContent value="insights">
          <div className="grid gap-4 sm:gap-6 grid-cols-1 md:grid-cols-2">
            <AIInsightsWidget />
            <AISuggestionsWidget
              pendingInvoices={stats.outstandingCount}
              overdueAmount={analytics?.receivables?.totalOverdue || 0}

            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
