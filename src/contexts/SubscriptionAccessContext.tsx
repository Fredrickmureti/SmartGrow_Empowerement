/**
 * SubscriptionAccessContext — RETIRED (single-institution build).
 *
 * Plan-based read-only degradation and upgrade prompts belonged to the SaaS
 * product. Smart Grow Empowerment is a single-company Microfinance system:
 * access is decided by internal RBAC (`user_roles` / permissions), never by
 * a subscription plan. This module now returns a constant "full access,
 * never read-only" value so remaining call sites behave correctly while they
 * are migrated to permission checks.
 */

import React from "react";

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

const FULL_ACCESS: SubscriptionAccessContextType = {
  isReadOnly: false,
  lockedFeature: null,
  requiredPlanName: null,
  currentPlanName: null,
  openUpgradeModal: () => {},
  closeUpgradeModal: () => {},
  upgradeModalOpen: false,
  upgradeModalFeature: null,
};

export function SubscriptionAccessProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function useSubscriptionAccess(): SubscriptionAccessContextType {
  return FULL_ACCESS;
}
