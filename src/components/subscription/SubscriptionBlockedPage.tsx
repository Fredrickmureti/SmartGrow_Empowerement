import { AlertTriangle, Lock, Clock, Mail, CreditCard, ArrowRight, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useNavigate } from "react-router-dom";
import { featureLabels } from "./SubscriptionGate";
import { useSubscription } from "@/hooks/useSubscription";
import { Badge } from "@/components/ui/badge";

interface SubscriptionBlockedPageProps {
  type: "suspended" | "expired" | "feature_locked";
  reason?: string | null;
  feature?: string;
  isTrialExpired?: boolean;
}

export function SubscriptionBlockedPage({ 
  type, 
  reason, 
  feature,
  isTrialExpired 
}: SubscriptionBlockedPageProps) {
  const navigate = useNavigate();
  const { plan, subscriptionStatus } = useSubscription();

  const handleContactSupport = () => {
    window.location.href = "mailto:support@example.com?subject=Account Support Request";
  };

  const getContent = () => {
    switch (type) {
      case "suspended":
        return {
          icon: AlertTriangle,
          iconColor: "text-destructive",
          bgColor: "bg-destructive/10",
          borderColor: "border-destructive/20",
          title: "Account Suspended",
          description: "Your organization account has been suspended by the platform administrator.",
          details: reason || "Please contact support for more information about this suspension.",
          showContact: true,
          showUpgrade: false,
          showSettings: false,
        };
      case "expired":
        return {
          icon: Clock,
          iconColor: "text-orange-500",
          bgColor: "bg-orange-500/10",
          borderColor: "border-orange-200",
          title: isTrialExpired ? "Your Free Trial Has Ended" : "Subscription Expired",
          description: isTrialExpired 
            ? "Your 14-day free trial has come to an end. We hope you enjoyed exploring our platform!"
            : "Your subscription period has ended. Renew now to continue accessing all your data and features.",
          details: isTrialExpired
            ? "Upgrade to a paid plan to unlock all features and continue managing your business."
            : "Your data is safe and will be available once you renew your subscription.",
          showContact: true,
          showUpgrade: true,
          showSettings: true,
        };
      case "feature_locked":
        return {
          icon: Lock,
          iconColor: "text-muted-foreground",
          bgColor: "bg-muted",
          borderColor: "border-muted",
          title: "Feature Not Available",
          description: `${featureLabels[feature || ""] || feature} requires an upgraded plan.`,
          details: plan 
            ? `Your current plan (${plan.name}) doesn't include this feature. Upgrade to access it.`
            : "Upgrade your subscription to access this feature.",
          showContact: false,
          showUpgrade: true,
          showSettings: false,
        };
    }
  };

  const content = getContent();
  const Icon = content.icon;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/30 p-4">
      <div className="w-full max-w-lg space-y-6">
        <Card className={`border-2 ${content.borderColor}`}>
          <CardHeader className="text-center pb-2">
            <div className={`mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full ${content.bgColor}`}>
              <Icon className={`h-10 w-10 ${content.iconColor}`} />
            </div>
            <CardTitle className="text-2xl font-bold">{content.title}</CardTitle>
            <CardDescription className="text-base mt-2">
              {content.description}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Details box */}
            <div className="p-4 rounded-lg bg-muted/50 border">
              <p className="text-sm text-muted-foreground text-center">
                {content.details}
              </p>
            </div>

            {/* Current plan info for expired */}
            {type === "expired" && plan && (
              <div className="flex items-center justify-center gap-2">
                <span className="text-sm text-muted-foreground">Previous plan:</span>
                <Badge variant="secondary">{plan.name}</Badge>
              </div>
            )}

            {/* Subscription status for expired */}
            {type === "expired" && subscriptionStatus.daysRemaining !== null && (
              <div className="text-center">
                <span className="text-sm text-destructive">
                  Expired {Math.abs(subscriptionStatus.daysRemaining)} days ago
                </span>
              </div>
            )}

            {/* Action Buttons */}
            <div className="space-y-3">
              {content.showUpgrade && (
                <Button 
                  className="w-full h-12 text-base font-medium" 
                  size="lg" 
                  onClick={() => navigate("/upgrade")}
                >
                  <CreditCard className="mr-2 h-5 w-5" />
                  {type === "expired" ? "Renew Subscription" : "Upgrade Plan"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              )}
              
              {content.showContact && (
                <Button 
                  variant="outline" 
                  className="w-full h-11" 
                  size="lg"
                  onClick={handleContactSupport}
                >
                  <Mail className="mr-2 h-4 w-4" />
                  Contact Support
                </Button>
              )}

              {content.showSettings && (
                <Button 
                  variant="ghost" 
                  className="w-full"
                  onClick={() => navigate("/settings")}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  Account Settings
                </Button>
              )}
            </div>

            {/* Footer note */}
            {type === "suspended" && (
              <p className="text-xs text-muted-foreground text-center pt-2">
                If you believe this suspension was made in error, please contact our support team.
              </p>
            )}

            {type === "expired" && (
              <p className="text-xs text-muted-foreground text-center pt-2">
                Questions about pricing? Contact our sales team for custom plans and discounts.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Quick links */}
        <div className="flex justify-center gap-4 text-sm">
          <Button variant="link" size="sm" onClick={() => navigate("/")}>
            Back to Home
          </Button>
          <Button variant="link" size="sm" onClick={() => navigate("/help")}>
            Help Center
          </Button>
        </div>
      </div>
    </div>
  );
}
