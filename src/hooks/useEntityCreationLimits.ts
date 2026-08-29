/**
 * useEntityCreationLimits — single-institution build.
 *
 * Replaces the retired SaaS `useSubscriptionLimits` hook. There are no plan
 * quotas in a single-company Microfinance deployment, so organization,
 * business and branch creation is always permitted. Kept as a hook (rather
 * than deleting the call sites) so creation dialogs keep a single place to
 * enforce structural limits should governance ever require them.
 */

import { useCallback } from "react";

export interface EntityLimitCheck {
  canCreate: boolean;
  currentCount: number;
  maxAllowed: number;
  isUnlimited: boolean;
  message?: string;
}

const UNLIMITED: EntityLimitCheck = {
  canCreate: true,
  currentCount: 0,
  maxAllowed: Number.MAX_SAFE_INTEGER,
  isUnlimited: true,
};

export function useEntityCreationLimits() {
  const check = useCallback(async (_scopeId?: string): Promise<EntityLimitCheck> => UNLIMITED, []);

  return {
    checkOrganizationLimit: check,
    checkBusinessLimit: check,
    checkBranchLimit: check,
  };
}
