// @ts-nocheck - Admin tables not in auto-generated types
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { 
  RefreshCw, 
  Play, 
  Clock, 
  CheckCircle2, 
  AlertTriangle,
  Loader2,
  Calendar
} from "lucide-react";
import { format } from "date-fns";
import { normalizeError } from "@/services/resilience";

interface ExpiryCheckResult {
  success: boolean;
  expired_trials: number;
  expired_subscriptions: number;
  total_expired: number;
  timestamp: string;
}

export function SubscriptionMaintenanceCard() {
  const { toast } = useToast();
  const [isRunning, setIsRunning] = useState(false);
  const [lastResult, setLastResult] = useState<ExpiryCheckResult | null>(null);

  const handleRunExpiryCheck = async () => {
    setIsRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke('check-subscription-expiry', {
        body: { source: 'manual' }
      });

      if (error) throw error;

      setLastResult(data);
      
      toast({
        title: "Expiry check completed",
        description: `${data.total_expired} subscription(s) expired.`,
      });
    } catch (error: any) {
      console.error("Error running expiry check:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to run expiry check",
        variant: "destructive",
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <RefreshCw className="h-5 w-5" />
          Subscription Maintenance
        </CardTitle>
        <CardDescription>
          Manage subscription expiry and cleanup tasks
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Run Expiry Check */}
        <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Run Expiry Check</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Manually check and expire overdue subscriptions
            </p>
          </div>
          <Button 
            onClick={handleRunExpiryCheck} 
            disabled={isRunning}
            size="sm"
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Run Now
          </Button>
        </div>

        {/* Last Result */}
        {lastResult && (
          <div className="p-4 rounded-lg border bg-green-500/5 border-green-200">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="font-medium text-green-700">Last Run Results</span>
            </div>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Trials Expired</p>
                <p className="text-lg font-semibold">{lastResult.expired_trials}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Subscriptions Expired</p>
                <p className="text-lg font-semibold">{lastResult.expired_subscriptions}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Run At</p>
                <p className="text-sm font-medium">
                  {format(new Date(lastResult.timestamp), "HH:mm:ss")}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Cron Job Info */}
        <div className="p-4 rounded-lg bg-blue-500/5 border border-blue-200">
          <div className="flex items-start gap-2">
            <Calendar className="h-4 w-4 text-blue-600 mt-0.5" />
            <div className="space-y-1">
              <span className="font-medium text-blue-700">Automatic Scheduling</span>
              <p className="text-sm text-muted-foreground">
                To enable automatic daily expiry checks, set up a cron job in your Supabase dashboard 
                that calls the <code className="bg-muted px-1 rounded">check-subscription-expiry</code> edge function daily.
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Recommended schedule: <code className="bg-muted px-1 rounded">0 2 * * *</code> (2 AM daily)
              </p>
            </div>
          </div>
        </div>

        {/* Warning for admins */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-200">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-700">
            Expired subscriptions will be blocked from accessing protected features until renewed.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
