import React, { createContext, useContext, useState, useCallback, useMemo } from "react";
import { useSession } from "@/contexts/SessionContext";

interface SubscriptionAccessContextType {
  isReadOnly: boolean;
  lockedFeature: string | null;
  requiredPlanName: string | null;
  currentPlanName: string | null;
  openUpgradeModal: (feature: string) => void;
  closeUpgradeModal: () => void;
  upgradeModalOpen: boolean;
  upgradeModalFeature: string | null;
}

const SubscriptionAccessContext = createContext<SubscriptionAccessContextType | undefined>(undefined);

interface SubscriptionAccessProviderProps {
  children: React.ReactNode;
  isReadOnly?: boolean;
  lockedFeature?: string | null;
}

export function SubscriptionAccessProvider({ 
  children, 
  isReadOnly = false,
  lockedFeature = null 
}: SubscriptionAccessProviderProps) {
  const { currentPlan } = useSession();
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [upgradeModalFeature, setUpgradeModalFeature] = useState<string | null>(null);

  const openUpgradeModal = useCallback((feature: string) => {
    setUpgradeModalFeature(feature);
    setUpgradeModalOpen(true);
  }, []);

  const closeUpgradeModal = useCallback(() => {
    setUpgradeModalOpen(false);
    setUpgradeModalFeature(null);
  }, []);

  // Required plan name is determined server-side via plan_feature_access.
  // For display purposes we use a generic label since feature→plan mapping is DB-driven.
  const requiredPlanName = useMemo(() => {
    if (!lockedFeature) return null;
    return "a higher plan";
  }, [lockedFeature]);

  const value = useMemo(() => ({
    isReadOnly,
    lockedFeature,
    requiredPlanName,
    currentPlanName: currentPlan?.name || null,
    openUpgradeModal,
    closeUpgradeModal,
    upgradeModalOpen,
    upgradeModalFeature,
  }), [isReadOnly, lockedFeature, requiredPlanName, currentPlan?.name, openUpgradeModal, closeUpgradeModal, upgradeModalOpen, upgradeModalFeature]);

  return (
    <SubscriptionAccessContext.Provider value={value}>
      {children}
    </SubscriptionAccessContext.Provider>
  );
}

export function useSubscriptionAccess() {
  const context = useContext(SubscriptionAccessContext);
  if (context === undefined) {
    // Return default values if not within provider (for non-gated pages)
    return {
      isReadOnly: false,
      lockedFeature: null,
      requiredPlanName: null,
      currentPlanName: null,
      openUpgradeModal: () => {},
      closeUpgradeModal: () => {},
      upgradeModalOpen: false,
      upgradeModalFeature: null,
    };
  }
  return context;
}
