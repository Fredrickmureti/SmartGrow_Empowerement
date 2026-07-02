import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { useSubscription } from "@/hooks/useSubscription";
import { useCheapestPlanForApp } from "@/hooks/useCheapestPlanForApp";
import { Crown, Check, Sparkles, Zap } from "lucide-react";

// Feature display names and benefits
const featureInfo: Record<string, { name: string; benefits: string[] }> = {
  pos: {
    name: "Point of Sale",
    benefits: [
      "Unlimited POS registers",
      "Real-time sales tracking",
      "Cash drawer management",
      "Receipt customization",
      "Offline mode support",
    ],
  },
  crm: {
    name: "CRM & Pipeline",
    benefits: [
      "Lead management & scoring",
      "Sales pipeline tracking",
      "Activity scheduling",
      "Deal forecasting",
      "Email integration",
    ],
  },
  projects: {
    name: "Projects & Tasks",
    benefits: [
      "Unlimited projects",
      "Task management",
      "Time tracking",
      "Kanban boards",
      "Team collaboration",
    ],
  },
  timesheets: {
    name: "Timesheets",
    benefits: [
      "Employee time tracking",
      "Approval workflows",
      "Overtime calculations",
      "Project time allocation",
      "Attendance reports",
    ],
  },
  leave: {
    name: "Leave Management",
    benefits: [
      "Leave request workflows",
      "Balance tracking",
      "Holiday calendars",
      "Approval chains",
      "Leave reports",
    ],
  },
  manufacturing: {
    name: "Manufacturing",
    benefits: [
      "Bill of Materials",
      "Work orders",
      "Production planning",
      "Quality control",
      "Shop floor control",
    ],
  },
  fleet: {
    name: "Fleet Management",
    benefits: [
      "Vehicle tracking",
      "Maintenance scheduling",
      "Fuel management",
      "Driver assignments",
      "Cost analytics",
    ],
  },
};

// Maps feature keys (used by useFeatureAccess / openUpgradeModal callers) to
// app ids in the registry, so the modal can resolve the cheapest plan that
// includes the underlying app and show a real plan name + price.
const FEATURE_TO_APP: Record<string, string> = {
  pos: "pos",
  payroll: "payroll",
  hr: "employees",
  employees: "employees",
  "time-off": "time-off",
  attendance: "attendance",
  // recruitment / sign / spreadsheets retired 2026-05-09
  timesheets: "timesheets",
  inventory: "inventory",
  crm: "crm",
  studio: "studio",
  reports: "reports",
  
  projects: "projects",
};

export function SubscriptionUpgradeModal() {
  const navigate = useNavigate();
  const { upgradeModalOpen, closeUpgradeModal, upgradeModalFeature, requiredPlanName } = useSubscriptionAccess();
  const { plan } = useSubscription();

  const feature = upgradeModalFeature || "pos";
  const info = featureInfo[feature] || { name: feature, benefits: [] };

  // Resolve the cheapest plan that includes this app — gives "Professional ($29/mo)"
  // instead of the generic "a higher plan" placeholder.
  const cheapest = useCheapestPlanForApp(FEATURE_TO_APP[feature] ?? null);
  const planLabel =
    cheapest.plan?.plan_name ?? requiredPlanName ?? "a higher plan";
  const upgradeCtaLabel = cheapest.plan
    ? cheapest.label // already includes price
    : `Upgrade to ${planLabel}`;

  const handleUpgrade = () => {
    closeUpgradeModal();
    navigate("/upgrade");
  };

  return (
    <Dialog open={upgradeModalOpen} onOpenChange={closeUpgradeModal}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="space-y-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500">
            <Crown className="h-6 w-6 text-white" />
          </div>
          <DialogTitle className="text-center text-xl">
            Unlock {info.name}
          </DialogTitle>
          <DialogDescription className="text-center">
            {info.name} is available on the{" "}
            <Badge variant="secondary" className="font-semibold">
              {planLabel}
            </Badge>{" "}
            plan and above.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Current plan indicator */}
          {plan && (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <span>Your current plan:</span>
              <Badge variant="outline">{plan.name}</Badge>
            </div>
          )}

          {/* Benefits list */}
          <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4 text-primary" />
              <span>What you'll unlock:</span>
            </div>
            <ul className="space-y-2">
              {info.benefits.map((benefit, index) => (
                <li key={index} className="flex items-start gap-2 text-sm">
                  <Check className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button 
            onClick={handleUpgrade} 
            className="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600"
          >
            <Zap className="mr-2 h-4 w-4" />
            {upgradeCtaLabel}
          </Button>
          <Button variant="ghost" onClick={closeUpgradeModal} className="w-full">
            Maybe Later
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
