import { useSession } from "@/contexts/SessionContext";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";

interface FeatureAccessResult {
  hasAccess: boolean;
  isReadOnly: boolean;
  requiredPlan: string | null;
  currentPlan: string | null;
  openUpgradeModal: () => void;
}

// Feature-to-plan mapping is fully database-driven via plan_feature_access.
// No hardcoded feature sets needed — "required plan" label is generic.

/**
 * useFeatureAccess v2 - Uses SessionContext for instant access checks
 * No more flicker - entitlements are pre-loaded at login
 */
export function useFeatureAccess(feature: string): FeatureAccessResult {
  const { hasEntitlement, currentPlan } = useSession();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  
  const hasAccess = hasEntitlement(feature);
  const requiredPlan = "a higher plan";
  const currentPlanName = currentPlan?.name || null;

  return {
    hasAccess,
    isReadOnly: isReadOnly || !hasAccess,
    requiredPlan: hasAccess ? null : requiredPlan,
    currentPlan: currentPlanName,
    openUpgradeModal: () => openUpgradeModal(feature),
  };
}
