import { useState, useEffect } from "react";
import { useAIAssistant } from "@/hooks/useAIAssistant";
import { useDashboardAnalytics } from "@/hooks/useDashboardAnalytics";
import { useAIInsightsCache } from "@/hooks/useAIInsightsCache";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { formatDistanceToNow } from "date-fns";

export function AIInsightsWidget() {
  const { getFinancialInsights, isLoading: isGenerating } = useAIAssistant();
  const { analytics } = useDashboardAnalytics();
  const { currentBusiness } = useBusinesses();
  const { 
    cachedContent: cachedInsights, 
    isLoading: isCacheLoading, 
    saveToCache, 
    clearCache,
    updatedAt 
  } = useAIInsightsCache<string>({ insightType: "financial_insights" });
  
  const [insights, setInsights] = useState<string | null>(null);

  // Reset local state when business context changes
  useEffect(() => {
    setInsights(null);
  }, [currentBusiness?.id]);

  // Sync cached content to local state
  useEffect(() => {
    if (cachedInsights && !insights) {
      setInsights(cachedInsights);
    }
  }, [cachedInsights, insights]);

  const generateInsights = async () => {
    if (!analytics) return;

    const result = await getFinancialInsights({
      revenue: analytics.salesSummary.totalSales,
      expenses: analytics.expenseCategories.totalExpenses,
      cashFlow: analytics.cashFlow.netCashFlow,
      receivables: analytics.receivables.totalReceivables,
      payables: analytics.payables.totalPayables,
      period: "current month",
      trends: {
        salesGrowth: analytics.salesSummary.salesGrowth,
        expenseGrowth: analytics.expenseCategories.expenseGrowth,
      },
    });

    if (result) {
      setInsights(result);
      // Save to persistent cache
      await saveToCache(result);
    }
  };

  const hasInsights = insights || cachedInsights;
  const isLoading = isCacheLoading;

  if (isLoading) {
    return (
      <Card className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/10 pointer-events-none" />
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI Financial Insights
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!hasInsights) {
    return (
      <Card className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/10 pointer-events-none" />
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI Financial Insights
          </CardTitle>
          <CardDescription>
            Get AI-powered analysis of your financial health
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <Sparkles className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-sm text-muted-foreground mb-4">
              Let AI analyze your financial data and provide personalized insights and recommendations.
            </p>
            <Button onClick={generateInsights} disabled={isGenerating}>
              {isGenerating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Generate Insights
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/10 pointer-events-none" />
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Sparkles className="h-5 w-5 shrink-0 text-primary" />
              <span className="truncate">AI Financial Insights</span>
            </CardTitle>
            {updatedAt && (
              <CardDescription className="mt-1 truncate">
                Updated {formatDistanceToNow(updatedAt, { addSuffix: true })}
              </CardDescription>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" title="Clear insights" onClick={async () => { await clearCache(); setInsights(null); }} disabled={isGenerating}>
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" title="Regenerate insights" onClick={generateInsights} disabled={isGenerating}>
              {isGenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isGenerating ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <MarkdownRenderer content={insights || cachedInsights || ""} />
        )}
      </CardContent>
    </Card>
  );
}
