import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { Eye, X, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

// Feature display names
const featureNames: Record<string, string> = {
  pos: "Point of Sale",
  crm: "CRM & Pipeline",
  projects: "Projects",
  timesheets: "Timesheets",
  leave: "Leave Management",
  manufacturing: "Manufacturing",
  fleet: "Fleet Management",
  hr: "HR",
  payroll: "Payroll",
};

interface SubscriptionReadOnlyBannerProps {
  className?: string;
}

export function SubscriptionReadOnlyBanner({ className }: SubscriptionReadOnlyBannerProps) {
  const navigate = useNavigate();
  const { isReadOnly, lockedFeature, requiredPlanName } = useSubscriptionAccess();
  const [dismissed, setDismissed] = useState(false);

  if (!isReadOnly || dismissed) {
    return null;
  }

  const featureName = lockedFeature ? (featureNames[lockedFeature] || lockedFeature) : "this feature";

  return (
    <div className={cn(
      "relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 rounded-lg border border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 dark:border-amber-800 px-4 py-3 mb-4",
      className
    )}>
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50">
          <Eye className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="text-sm">
          <span className="font-medium text-amber-800 dark:text-amber-200">Preview Mode</span>
          <span className="text-amber-700 dark:text-amber-300 ml-1">
            – You're viewing {featureName}. Upgrade to {requiredPlanName} to unlock all actions.
          </span>
        </div>
      </div>
      
      <div className="flex items-center gap-2 self-end sm:self-auto">
        <Button 
          size="sm" 
          className="bg-amber-500 hover:bg-amber-600 text-white"
          onClick={() => navigate("/upgrade")}
        >
          <Zap className="mr-1.5 h-3.5 w-3.5" />
          Upgrade
        </Button>
        <Button 
          variant="ghost" 
          size="icon" 
          className="h-8 w-8 text-amber-600 hover:text-amber-700 dark:text-amber-400"
          onClick={() => setDismissed(true)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
