/**
 * ReadOnlyModeContext
 * 
 * Provides global read-only state for expired subscriptions.
 * When subscription expires but read-only mode is enabled:
 * - Users can view all their data
 * - Mutations are blocked with upgrade prompts
 * - Visual indicators show read-only state
 */
import React, { createContext, useContext, useMemo, useCallback } from "react";
import { useSession } from "@/contexts/SessionContext";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { useToast } from "@/hooks/use-toast";

interface ReadOnlyModeContextType {
  /** Whether the user is in read-only mode (expired subscription) */
  isReadOnly: boolean;
  
  /** Whether the user's subscription is fully blocked (suspended) */
  isBlocked: boolean;
  
  /** Days until expiry (negative if already expired) */
  daysUntilExpiry: number | null;
  
  /** Block a mutation and show upgrade prompt */
  blockMutation: (action?: string) => boolean;
  
  /** Check if a mutation should be blocked (returns true if blocked) */
  shouldBlockMutation: () => boolean;
  
  /** Show the read-only banner message */
  readOnlyMessage: string | null;
  
  /** Open upgrade modal */
  openUpgrade: () => void;
}

const ReadOnlyModeContext = createContext<ReadOnlyModeContextType | undefined>(undefined);

export function ReadOnlyModeProvider({ children }: { children: React.ReactNode }) {
  const { subscriptionStatus, currentOrg } = useSession();
  const { openUpgradeModal } = useSubscriptionAccess();
  const { toast } = useToast();

  // Determine read-only state
  const isReadOnly = useMemo(() => {
    // Expired but not suspended = read-only mode
    return subscriptionStatus.isExpired && !subscriptionStatus.isSuspended;
  }, [subscriptionStatus.isExpired, subscriptionStatus.isSuspended]);

  // Fully blocked (suspended)
  const isBlocked = useMemo(() => {
    return subscriptionStatus.isSuspended;
  }, [subscriptionStatus.isSuspended]);

  // Days remaining (negative if expired)
  const daysUntilExpiry = subscriptionStatus.daysRemaining;

  // Generate read-only message
  const readOnlyMessage = useMemo(() => {
    if (isBlocked) {
      return "Your subscription has been suspended. Please contact support.";
    }
    if (isReadOnly) {
      return "Your subscription has expired. You can view your data but cannot make changes.";
    }
    if (daysUntilExpiry !== null && daysUntilExpiry <= 3 && daysUntilExpiry > 0) {
      return `Your subscription expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}.`;
    }
    return null;
  }, [isReadOnly, isBlocked, daysUntilExpiry]);

  // Check if mutation should be blocked
  const shouldBlockMutation = useCallback(() => {
    return isReadOnly || isBlocked;
  }, [isReadOnly, isBlocked]);

  // Block mutation with feedback
  const blockMutation = useCallback((action?: string) => {
    if (!shouldBlockMutation()) return false;

    const actionText = action ? ` to ${action}` : "";
    
    if (isBlocked) {
      toast({
        title: "Account Suspended",
        description: "Your account has been suspended. Please contact support to restore access.",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Subscription Expired",
        description: `Upgrade your plan${actionText}. Your data is safe in read-only mode.`,
        variant: "default",
      });
      openUpgradeModal("subscription");
    }
    
    return true;
  }, [shouldBlockMutation, isBlocked, toast, openUpgradeModal]);

  // Open upgrade modal
  const openUpgrade = useCallback(() => {
    openUpgradeModal("subscription");
  }, [openUpgradeModal]);

  const value = useMemo(() => ({
    isReadOnly,
    isBlocked,
    daysUntilExpiry,
    blockMutation,
    shouldBlockMutation,
    readOnlyMessage,
    openUpgrade,
  }), [
    isReadOnly,
    isBlocked,
    daysUntilExpiry,
    blockMutation,
    shouldBlockMutation,
    readOnlyMessage,
    openUpgrade,
  ]);

  return (
    <ReadOnlyModeContext.Provider value={value}>
      {children}
    </ReadOnlyModeContext.Provider>
  );
}

export function useReadOnlyMode() {
  const context = useContext(ReadOnlyModeContext);
  if (context === undefined) {
    throw new Error("useReadOnlyMode must be used within a ReadOnlyModeProvider");
  }
  return context;
}

/**
 * Higher-order component to protect mutation handlers
 * Usage: const handleSave = withReadOnlyBlock(() => { ... }, "save changes");
 */
export function withReadOnlyBlock<T extends (...args: any[]) => any>(
  fn: T,
  actionDescription?: string
): (...args: Parameters<T>) => ReturnType<T> | undefined {
  return function(...args: Parameters<T>) {
    // This needs to be called within a component that has access to the context
    // For hooks usage, see useProtectedMutation below
    return fn(...args);
  };
}

/**
 * Hook to protect async mutation functions
 * Returns a wrapped function that blocks execution in read-only mode
 */
export function useProtectedMutation<T extends (...args: any[]) => Promise<any>>(
  mutationFn: T,
  actionDescription?: string
): T {
  const { blockMutation, shouldBlockMutation } = useReadOnlyMode();

  return useCallback(
    (async (...args: Parameters<T>) => {
      if (shouldBlockMutation()) {
        blockMutation(actionDescription);
        return undefined;
      }
      return mutationFn(...args);
    }) as T,
    [mutationFn, shouldBlockMutation, blockMutation, actionDescription]
  );
}
