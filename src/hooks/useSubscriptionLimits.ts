import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/hooks/useOrganization";

interface LimitCheckResult {
  canCreate: boolean;
  currentCount: number;
  maxAllowed: number | null;
  isUnlimited: boolean;
}

export function useSubscriptionLimits() {
  const { user } = useAuth();
  const { currentOrg } = useOrganization();
  const [isChecking, setIsChecking] = useState(false);

  const checkOrganizationLimit = useCallback(async (): Promise<LimitCheckResult> => {
    if (!user?.id) {
      return { canCreate: false, currentCount: 0, maxAllowed: 1, isUnlimited: false };
    }

    setIsChecking(true);
    try {
      const { data, error } = await supabase
        .rpc('check_user_org_limit', { _user_id: user.id });

      if (error) {
        console.error("Error checking org limit:", error);
        // Default to allowing creation on error
        return { canCreate: true, currentCount: 0, maxAllowed: null, isUnlimited: true };
      }

      if (data && data.length > 0) {
        const result = data[0];
        return {
          canCreate: result.can_create,
          currentCount: result.current_count,
          maxAllowed: result.max_allowed,
          isUnlimited: result.max_allowed === null,
        };
      }

      return { canCreate: true, currentCount: 0, maxAllowed: null, isUnlimited: true };
    } catch (error) {
      console.error("Error checking org limit:", error);
      return { canCreate: true, currentCount: 0, maxAllowed: null, isUnlimited: true };
    } finally {
      setIsChecking(false);
    }
  }, [user?.id]);

  const checkBusinessLimit = useCallback(async (): Promise<LimitCheckResult> => {
    if (!currentOrg?.id) {
      return { canCreate: false, currentCount: 0, maxAllowed: 1, isUnlimited: false };
    }

    setIsChecking(true);
    try {
      const { data, error } = await supabase
        .rpc('check_org_business_limit', { _org_id: currentOrg.id });

      if (error) {
        console.error("Error checking business limit:", error);
        return { canCreate: true, currentCount: 0, maxAllowed: null, isUnlimited: true };
      }

      if (data && data.length > 0) {
        const result = data[0];
        return {
          canCreate: result.can_create,
          currentCount: result.current_count,
          maxAllowed: result.max_allowed,
          isUnlimited: result.max_allowed === null,
        };
      }

      return { canCreate: true, currentCount: 0, maxAllowed: null, isUnlimited: true };
    } catch (error) {
      console.error("Error checking business limit:", error);
      return { canCreate: true, currentCount: 0, maxAllowed: null, isUnlimited: true };
    } finally {
      setIsChecking(false);
    }
  }, [currentOrg?.id]);

  const checkBranchLimit = useCallback(async (businessId: string): Promise<LimitCheckResult> => {
    if (!businessId) {
      return { canCreate: false, currentCount: 0, maxAllowed: 1, isUnlimited: false };
    }

    setIsChecking(true);
    try {
      const { data, error } = await supabase
        .rpc('check_business_branch_limit', { _business_id: businessId });

      if (error) {
        console.error("Error checking branch limit:", error);
        return { canCreate: true, currentCount: 0, maxAllowed: null, isUnlimited: true };
      }

      if (data && data.length > 0) {
        const result = data[0];
        return {
          canCreate: result.can_create,
          currentCount: result.current_count,
          maxAllowed: result.max_allowed,
          isUnlimited: result.max_allowed === null,
        };
      }

      return { canCreate: true, currentCount: 0, maxAllowed: null, isUnlimited: true };
    } catch (error) {
      console.error("Error checking branch limit:", error);
      return { canCreate: true, currentCount: 0, maxAllowed: null, isUnlimited: true };
    } finally {
      setIsChecking(false);
    }
  }, []);

  return {
    isChecking,
    checkOrganizationLimit,
    checkBusinessLimit,
    checkBranchLimit,
  };
}
