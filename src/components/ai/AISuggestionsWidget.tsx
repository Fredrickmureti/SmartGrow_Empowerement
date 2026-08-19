import { useState, useEffect } from "react";
import { useAIAssistant } from "@/hooks/useAIAssistant";
import { useAIInsightsCache } from "@/hooks/useAIInsightsCache";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Loader2, ArrowRight, FileText, Clock, RefreshCw, GitCompare, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";

interface Suggestion {
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  actionType: string;
}

interface AISuggestionsWidgetProps {
  pendingInvoices: number;
  overdueAmount: number;
}

export function AISuggestionsWidget({ pendingInvoices, overdueAmount }: AISuggestionsWidgetProps) {
  const { suggestActions, isLoading: isGenerating } = useAIAssistant();
  const { 
    cachedContent: cachedSuggestions, 
    isLoading: isCacheLoading, 
    saveToCache,
    clearCache,
    updatedAt 
  } = useAIInsightsCache<Suggestion[]>({ insightType: "suggestions" });
  
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const navigate = useNavigate();
  const { currentBusiness } = useBusinesses();

  // Reset local state when business context changes
  useEffect(() => {
    setSuggestions([]);
  }, [currentBusiness?.id]);

  // Sync cached content to local state
  useEffect(() => {
    if (cachedSuggestions && cachedSuggestions.length > 0 && suggestions.length === 0) {
      setSuggestions(cachedSuggestions);
    }
  }, [cachedSuggestions, suggestions.length]);

  const fetchSuggestions = async () => {
    const result = await suggestActions({
      pendingInvoices,
      overdueAmount,
    });
    
    if (result && result.length > 0) {
      const newSuggestions = result.slice(0, 3);
      setSuggestions(newSuggestions);
      // Save to persistent cache
      await saveToCache(newSuggestions);
    }
  };

  const getActionIcon = (actionType: string) => {
    switch (actionType) {
      case "create_invoice": return FileText;
      case "follow_up": return Clock;
      case "reconcile": return GitCompare;
      default: return ArrowRight;
    }
  };

  const handleAction = (actionType: string) => {
    switch (actionType) {
      case "create_invoice":
        navigate("/invoices");
        break;
      case "follow_up":
        navigate("/invoices");
        break;
      case "reconcile":
        navigate("/finance/reconciliation");
        break;
      default:
        break;
    }
  };

  const priorityStyles: Record<string, string> = {
    high: "bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400",
    medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400",
    low: "bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400",
  };

  const hasSuggestions = suggestions.length > 0 || (cachedSuggestions && cachedSuggestions.length > 0);
  const displaySuggestions = suggestions.length > 0 ? suggestions : (cachedSuggestions || []);
  const isLoading = isCacheLoading;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Sparkles className="h-5 w-5 shrink-0 text-primary" />
            <span className="truncate">AI Suggestions</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!hasSuggestions && !isGenerating) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Sparkles className="h-5 w-5 shrink-0 text-primary" />
              <span className="truncate">AI Suggestions</span>
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4">
            <p className="text-sm text-muted-foreground mb-3">
              Get AI-powered action suggestions based on your data
            </p>
            <Button variant="outline" size="sm" onClick={fetchSuggestions} disabled={isGenerating}>
              {isGenerating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              Get Suggestions
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Sparkles className="h-5 w-5 shrink-0 text-primary" />
              <span className="truncate">AI Suggestions</span>
            </CardTitle>
            {updatedAt && (
              <CardDescription className="mt-1 truncate">
                Updated {formatDistanceToNow(updatedAt, { addSuffix: true })}
              </CardDescription>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="icon" title="Clear suggestions" onClick={async () => { await clearCache(); setSuggestions([]); }} disabled={isGenerating}>
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" title="Regenerate suggestions" onClick={fetchSuggestions} disabled={isGenerating}>
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
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {displaySuggestions.map((suggestion, index) => {
              const Icon = getActionIcon(suggestion.actionType);
              return (
                <div
                  key={index}
                  className="flex items-start gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => handleAction(suggestion.actionType)}
                >
                  <div className="p-2 rounded-md bg-primary/10">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm truncate">{suggestion.title}</span>
                      <Badge className={priorityStyles[suggestion.priority]} variant="secondary">
                        {suggestion.priority}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {suggestion.description}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
