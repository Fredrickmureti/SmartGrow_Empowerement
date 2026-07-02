import { AlertTriangle, Clock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { useSubscription } from "@/hooks/useSubscription";
import { useState } from "react";

export function SubscriptionStatusBanner() {
  const navigate = useNavigate();
  const { subscriptionStatus, plan } = useSubscription();
  const [isDismissed, setIsDismissed] = useState(() => {
    return sessionStorage.getItem("subscription-banner-dismissed") === "true";
  });

  // Don't show if dismissed or no warning needed
  if (isDismissed) return null;

  const daysRemaining = subscriptionStatus.daysRemaining;

  // Show warning banner for trials or subscriptions expiring within 7 days
  const showTrialWarning = subscriptionStatus.isTrialing && daysRemaining !== null && daysRemaining <= 7;
  const showExpiryWarning = subscriptionStatus.status === 'active' && daysRemaining !== null && daysRemaining <= 7;

  if (!showTrialWarning && !showExpiryWarning) return null;

  const isUrgent = daysRemaining !== null && daysRemaining <= 3;
  const bgColor = isUrgent ? "bg-destructive" : "bg-orange-500";
  const textColor = "text-white";

  const getMessage = () => {
    if (daysRemaining === null) return "";
    
    if (daysRemaining <= 0) {
      return subscriptionStatus.isTrialing 
        ? "Your trial has expired. Upgrade now to continue."
        : "Your subscription has expired. Renew now to continue.";
    }
    
    if (daysRemaining === 1) {
      return subscriptionStatus.isTrialing
        ? "Your trial expires tomorrow! Upgrade to keep access."
        : "Your subscription expires tomorrow! Renew to keep access.";
    }
    
    return subscriptionStatus.isTrialing
      ? `Your trial expires in ${daysRemaining} days. Upgrade now to keep access.`
      : `Your subscription expires in ${daysRemaining} days. Renew to continue.`;
  };

  return (
    <div className={`${bgColor} ${textColor} px-4 py-2`}>
      <div className="container mx-auto flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {isUrgent ? (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          ) : (
            <Clock className="h-4 w-4 shrink-0" />
          )}
          <span className="text-sm font-medium">
            {getMessage()}
          </span>
          {plan && (
            <span className="text-xs opacity-80">
              ({plan.name})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button 
            size="sm" 
            variant="secondary"
            className="h-7 text-xs"
            onClick={() => navigate("/upgrade")}
          >
            {subscriptionStatus.isTrialing ? "Upgrade Now" : "Renew Now"}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 hover:bg-white/20"
            onClick={() => {
              setIsDismissed(true);
              sessionStorage.setItem("subscription-banner-dismissed", "true");
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
