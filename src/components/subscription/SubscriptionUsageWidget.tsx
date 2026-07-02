import { useSubscription } from "@/hooks/useSubscription";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { Sparkles, Users, FileText, AlertTriangle } from "lucide-react";

interface SubscriptionUsageWidgetProps {
  compact?: boolean;
}

export function SubscriptionUsageWidget({ compact = false }: SubscriptionUsageWidgetProps) {
  const navigate = useNavigate();
  const { plan, usage, subscriptionStatus, getFeatureLimit, isLoading } = useSubscription();

  if (isLoading || !plan) {
    return null;
  }

  const maxUsers = getFeatureLimit("max_users");
  const maxInvoices = getFeatureLimit("max_invoices");

  const currentInvoices = usage?.invoices_count ?? 0;
  const currentUsers = usage?.users_count ?? 0;

  const userUsage = maxUsers ? Math.min((currentUsers / maxUsers) * 100, 100) : 0;
  const invoiceUsage = maxInvoices ? Math.min((currentInvoices / maxInvoices) * 100, 100) : 0;

  const isNearUserLimit = maxUsers && currentUsers >= maxUsers * 0.8;
  const isNearInvoiceLimit = maxInvoices && currentInvoices >= maxInvoices * 0.8;
  const isAtUserLimit = maxUsers && currentUsers >= maxUsers;
  const isAtInvoiceLimit = maxInvoices && currentInvoices >= maxInvoices;

  // Calculate days remaining for trial
  const daysRemaining = subscriptionStatus.trialEndsAt 
    ? Math.max(0, Math.ceil((new Date(subscriptionStatus.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  if (compact) {
    return (
      <div className="space-y-2 p-3 bg-muted/50 rounded-lg">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{plan.name}</span>
          {subscriptionStatus.isTrialing && (
            <Badge variant="secondary" className="text-xs">Trial</Badge>
          )}
        </div>
        
        {(isNearUserLimit || isNearInvoiceLimit) && (
          <div className="flex items-center gap-1.5 text-xs text-warning">
            <AlertTriangle className="h-3 w-3" />
            <span>Approaching limit</span>
          </div>
        )}

        <Button 
          variant="ghost" 
          size="sm" 
          className="w-full text-xs h-7"
          onClick={() => navigate("/upgrade")}
        >
          <Sparkles className="mr-1 h-3 w-3" />
          Upgrade
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {plan.name} Plan
          </CardTitle>
          {subscriptionStatus.isTrialing && daysRemaining !== null && (
            <Badge variant="secondary">
              {daysRemaining} days left
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Team Members Usage */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span>Team Members</span>
            </div>
            <span className={isAtUserLimit ? "text-destructive font-medium" : ""}>
              {currentUsers} / {maxUsers || "∞"}
            </span>
          </div>
          {maxUsers && (
            <Progress 
              value={userUsage} 
              className={`h-2 ${isAtUserLimit ? "[&>div]:bg-destructive" : isNearUserLimit ? "[&>div]:bg-warning" : ""}`}
            />
          )}
        </div>

        {/* Invoices Usage */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span>Invoices This Month</span>
            </div>
            <span className={isAtInvoiceLimit ? "text-destructive font-medium" : ""}>
              {currentInvoices} / {maxInvoices || "∞"}
            </span>
          </div>
          {maxInvoices && (
            <Progress 
              value={invoiceUsage} 
              className={`h-2 ${isAtInvoiceLimit ? "[&>div]:bg-destructive" : isNearInvoiceLimit ? "[&>div]:bg-warning" : ""}`}
            />
          )}
        </div>

        {/* Upgrade CTA */}
        {(isNearUserLimit || isNearInvoiceLimit || subscriptionStatus.isTrialing) && (
          <Button 
            variant="outline" 
            className="w-full"
            onClick={() => navigate("/upgrade")}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            Upgrade Plan
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
