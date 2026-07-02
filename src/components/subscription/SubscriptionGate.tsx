import { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "@/contexts/SessionContext";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface SubscriptionGateProps {
  children: ReactNode;
  feature: string;
  fallback?: ReactNode;
  showUpgradePrompt?: boolean;
}

/**
 * Feature labels — ONLY real features that exist in the platform.
 * Removed false claims: api_access, custom_branding, business_intelligence.
 * Attendance is part of HR app, not a standalone premium feature.
 */
const featureLabels: Record<string, string> = {
  // Cross-cutting premium features (real)
  multi_currency: "Multi-Currency Support",
  ai_assistant: "AI Assistant",
  audit_logs: "Audit Logs",
  team_management: "Team Management",
  
  // App-level labels (shown when app is blocked via plan_app_access)
  pos: "Point of Sale",
  finance: "Finance & Accounting",
  sales: "Sales",
  purchases: "Purchases",
  inventory: "Inventory Management",
  hr: "HR & Payroll",
  crm: "CRM & Sales Pipeline",
  projects: "Project Management",
  documents: "Document Management",
  sign: "Digital Signatures",
  spreadsheets: "Spreadsheets",
};

/**
 * SubscriptionGate v2 - Uses SessionContext for instant access checks
 * No more flicker - entitlements are pre-loaded at login
 */
export function SubscriptionGate({ 
  children, 
  feature, 
  fallback = null,
  showUpgradePrompt = true 
}: SubscriptionGateProps) {
  const navigate = useNavigate();
  const { hasEntitlement, currentPlan, isLoading } = useSession();

  if (isLoading) {
    return null;
  }

  const hasAccess = hasEntitlement(feature);

  if (hasAccess) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  if (!showUpgradePrompt) {
    return null;
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Lock className="h-6 w-6 text-muted-foreground" />
        </div>
        <CardTitle>Upgrade Required</CardTitle>
        <CardDescription>
          {featureLabels[feature] || feature} is not available on your current plan
          {currentPlan ? ` (${currentPlan.name})` : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-center">
        <Button variant="default" onClick={() => navigate("/upgrade")}>
          Upgrade Plan
        </Button>
      </CardContent>
    </Card>
  );
}

export { featureLabels };

/**
 * SubscriptionFeatureCheck - Render prop pattern for feature checks
 */
export function SubscriptionFeatureCheck({ 
  feature, 
  children 
}: { 
  feature: string; 
  children: (hasAccess: boolean) => ReactNode;
}) {
  const { hasEntitlement, isLoading } = useSession();

  if (isLoading) {
    return null;
  }

  return <>{children(hasEntitlement(feature))}</>;
}
