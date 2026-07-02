import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";
import { useAIProviders } from "@/hooks/useAIProviders";
import { AIProviderCard } from "./AIProviderCard";
import { useToast } from "@/hooks/use-toast";
import { 
  Bot, 
  Sparkles, 
  Zap, 
  AlertTriangle, 
  Loader2, 
  BarChart3,
  Activity
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { normalizeError } from "@/services/resilience";

export function AIProviderSettings() {
  const { settings, isLoading: isLoadingSettings, isSaving, getSetting, updateSetting, updateMultipleSettings } = usePlatformSettings();
  const { 
    providers, 
    apiKeys, 
    usageLogs,
    isLoading: isLoadingProviders, 
    isSaving: isSavingProviders,
    updateProvider,
    addApiKey,
    updateApiKey,
    deleteApiKey,
    testApiKey,
    getProviderKeys,
    refreshAll
  } = useAIProviders();
  const { toast } = useToast();

  const [aiEnabled, setAiEnabled] = useState(true);
  const [enableExpenseCategorization, setEnableExpenseCategorization] = useState(true);
  const [enableInvoiceAnalysis, setEnableInvoiceAnalysis] = useState(true);
  const [enableFinancialInsights, setEnableFinancialInsights] = useState(true);
  const [enableAIChat, setEnableAIChat] = useState(true);

  useEffect(() => {
    if (settings.length > 0) {
      setAiEnabled(getSetting("ai_enabled") !== "false");
      setEnableExpenseCategorization(getSetting("ai_expense_categorization") !== "false");
      setEnableInvoiceAnalysis(getSetting("ai_invoice_analysis") !== "false");
      setEnableFinancialInsights(getSetting("ai_financial_insights") !== "false");
      setEnableAIChat(getSetting("ai_chat_enabled") !== "false");
    }
  }, [settings, getSetting]);

  const handleToggleAI = async (enabled: boolean) => {
    setAiEnabled(enabled);
    await updateSetting("ai_enabled", enabled.toString());
    toast({ 
      title: enabled ? "AI features enabled" : "AI features disabled",
      description: enabled ? "Users can now use AI-powered features" : "AI features are now disabled platform-wide"
    });
  };

  const handleSaveFeatures = async () => {
    try {
      await updateMultipleSettings([
        { key: "ai_expense_categorization", value: enableExpenseCategorization.toString() },
        { key: "ai_invoice_analysis", value: enableInvoiceAnalysis.toString() },
        { key: "ai_financial_insights", value: enableFinancialInsights.toString() },
        { key: "ai_chat_enabled", value: enableAIChat.toString() },
      ]);
      toast({ title: "Feature settings saved" });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const isLoading = isLoadingSettings || isLoadingProviders;

  // Calculate usage stats
  const totalRequests = usageLogs.length;
  const rateLimitedRequests = usageLogs.filter(l => l.was_rate_limited).length;
  const fallbackRequests = usageLogs.filter(l => l.was_fallback).length;
  const avgResponseTime = usageLogs.length > 0 
    ? Math.round(usageLogs.reduce((sum, l) => sum + (l.response_time_ms || 0), 0) / usageLogs.length)
    : 0;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* AI Status Card */}
      <Card className={aiEnabled ? "border-green-500/30 bg-green-500/5" : "border-orange-500/30 bg-orange-500/5"}>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base sm:text-lg">
            <Bot className="h-4 w-4 sm:h-5 sm:w-5" />
            AI Assistant Status
            <Badge variant={aiEnabled ? "default" : "secondary"} className={aiEnabled ? "bg-green-500" : ""}>
              {aiEnabled ? "Active" : "Disabled"}
            </Badge>
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Control AI-powered features across the AccrualFlow platform
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 pt-0 sm:pt-0">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5 min-w-0">
              <p className="text-sm sm:text-base font-medium">Enable AI Features</p>
              <p className="text-xs sm:text-sm text-muted-foreground">
                Toggle all AI-powered functionality for the platform
              </p>
            </div>
            <Switch checked={aiEnabled} onCheckedChange={handleToggleAI} className="shrink-0" />
          </div>
          {!aiEnabled && (
            <div className="mt-4 p-3 rounded-lg bg-orange-500/10 border border-orange-500/20 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-orange-600 mt-0.5" />
              <p className="text-sm text-orange-700 dark:text-orange-400">
                AI features are currently disabled. Users will not have access to expense categorization, invoice analysis, or the AI chat assistant.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="providers" className="space-y-4 sm:space-y-6">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="providers" className="flex items-center gap-1.5 text-xs sm:text-sm">
            <Sparkles className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            Providers
          </TabsTrigger>
          <TabsTrigger value="features" className="flex items-center gap-1.5 text-xs sm:text-sm">
            <Zap className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            Features
          </TabsTrigger>
          <TabsTrigger value="usage" className="flex items-center gap-1.5 text-xs sm:text-sm">
            <BarChart3 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            Usage
          </TabsTrigger>
        </TabsList>

        {/* AI Providers Tab */}
        <TabsContent value="providers" className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-base sm:text-lg font-medium">AI Providers</h3>
              <p className="text-xs sm:text-sm text-muted-foreground">
                Configure AI providers and API keys. Lower priority providers are used first.
              </p>
            </div>
            <Button variant="outline" size="sm" className="self-start sm:self-auto shrink-0" onClick={refreshAll}>
              <Activity className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>

          <div className="space-y-4">
            {providers.map((provider) => (
              <AIProviderCard
                key={provider.id}
                provider={provider}
                apiKeys={getProviderKeys(provider.id)}
                onUpdateProvider={updateProvider}
                onAddApiKey={addApiKey}
                onUpdateApiKey={updateApiKey}
                onDeleteApiKey={deleteApiKey}
                onTestApiKey={testApiKey}
                isSaving={isSavingProviders}
              />
            ))}
          </div>

          {providers.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <Bot className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>No AI providers configured yet.</p>
                <p className="text-sm">Add providers in the database to get started.</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Features Tab */}
        <TabsContent value="features" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Feature Controls
              </CardTitle>
              <CardDescription>
                Enable or disable specific AI features
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="font-medium">Expense Categorization</p>
                  <p className="text-xs text-muted-foreground">Auto-categorize expenses using AI</p>
                </div>
                <Switch
                  checked={enableExpenseCategorization}
                  onCheckedChange={setEnableExpenseCategorization}
                  disabled={!aiEnabled}
                />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="font-medium">Invoice Analysis</p>
                  <p className="text-xs text-muted-foreground">Analyze invoices for insights</p>
                </div>
                <Switch
                  checked={enableInvoiceAnalysis}
                  onCheckedChange={setEnableInvoiceAnalysis}
                  disabled={!aiEnabled}
                />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="font-medium">Financial Insights</p>
                  <p className="text-xs text-muted-foreground">AI-powered financial analysis</p>
                </div>
                <Switch
                  checked={enableFinancialInsights}
                  onCheckedChange={setEnableFinancialInsights}
                  disabled={!aiEnabled}
                />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="font-medium">AI Chat Assistant</p>
                  <p className="text-xs text-muted-foreground">Interactive AI chat for users</p>
                </div>
                <Switch
                  checked={enableAIChat}
                  onCheckedChange={setEnableAIChat}
                  disabled={!aiEnabled}
                />
              </div>

              <div className="pt-4">
                <Button onClick={handleSaveFeatures} disabled={isSaving || !aiEnabled}>
                  {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Save Feature Settings
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Usage Tab */}
        <TabsContent value="usage" className="space-y-4">
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Requests</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{totalRequests}</div>
                <p className="text-xs text-muted-foreground">Last 50 logged</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Rate Limited</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-orange-600">{rateLimitedRequests}</div>
                <p className="text-xs text-muted-foreground">Requests throttled</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Fallback Used</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-blue-600">{fallbackRequests}</div>
                <p className="text-xs text-muted-foreground">Automatic failover</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Avg Response Time</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{avgResponseTime}ms</div>
                <p className="text-xs text-muted-foreground">API latency</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent AI Requests</CardTitle>
              <CardDescription>Latest API calls across all providers</CardDescription>
            </CardHeader>
            <CardContent>
              {usageLogs.length > 0 ? (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {usageLogs.slice(0, 20).map((log) => (
                    <div
                      key={log.id}
                      className="flex flex-col gap-2 p-3 rounded-lg border bg-card text-sm sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-xs">{log.provider_code}</Badge>
                        <span className="text-xs sm:text-sm text-muted-foreground truncate">{log.request_type}</span>
                        {log.model_used && (
                          <span className="text-xs text-muted-foreground hidden sm:inline">({log.model_used})</span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {log.was_rate_limited && (
                          <Badge variant="destructive" className="text-xs">Rate Limited</Badge>
                        )}
                        {log.was_fallback && (
                          <Badge variant="secondary" className="text-xs">Fallback</Badge>
                        )}
                        {log.response_time_ms && (
                          <span className="text-xs text-muted-foreground">{log.response_time_ms}ms</span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(log.created_at))} ago
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-muted-foreground">
                  <Activity className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p>No AI usage logs yet</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
