import { useState, useCallback } from "react";

interface AgeRestrictedItem {
  id: string;
  name: string;
  min_age: number;
}

interface CartItem {
  id: string;
  name: string;
  is_age_restricted?: boolean;
  min_age?: number | null;
}

export function usePOSAgeVerification() {
  const [isVerified, setIsVerified] = useState(false);
  const [verificationMethod, setVerificationMethod] = useState<
    "id_check" | "dob_entry" | "manager_override" | null
  >(null);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);

  /**
   * Check if cart contains age-restricted items
   */
  const getRestrictedItems = useCallback((items: CartItem[]): AgeRestrictedItem[] => {
    return items
      .filter((item) => item.is_age_restricted && item.min_age)
      .map((item) => ({
        id: item.id,
        name: item.name,
        min_age: item.min_age!,
      }));
  }, []);

  /**
   * Get the maximum required age from cart items
   */
  const getRequiredAge = useCallback((items: CartItem[]): number => {
    const restricted = getRestrictedItems(items);
    if (restricted.length === 0) return 0;
    return Math.max(...restricted.map((item) => item.min_age));
  }, [getRestrictedItems]);

  /**
   * Check if verification is needed for current cart
   */
  const needsVerification = useCallback(
    (items: CartItem[]): boolean => {
      if (isVerified) return false;
      return getRestrictedItems(items).length > 0;
    },
    [isVerified, getRestrictedItems]
  );

  /**
   * Mark age as verified
   */
  const verify = useCallback(
    (method: "id_check" | "dob_entry" | "manager_override") => {
      setIsVerified(true);
      setVerificationMethod(method);
      setVerifiedAt(new Date().toISOString());
    },
    []
  );

  /**
   * Reset verification (for new transaction)
   */
  const reset = useCallback(() => {
    setIsVerified(false);
    setVerificationMethod(null);
    setVerifiedAt(null);
  }, []);

  /**
   * Get verification data for transaction
   */
  const getVerificationData = useCallback(() => {
    if (!isVerified) return null;
    return {
      age_verification_method: verificationMethod,
      age_verified_at: verifiedAt,
    };
  }, [isVerified, verificationMethod, verifiedAt]);

  return {
    isVerified,
    verificationMethod,
    verifiedAt,
    getRestrictedItems,
    getRequiredAge,
    needsVerification,
    verify,
    reset,
    getVerificationData,
  };
}
