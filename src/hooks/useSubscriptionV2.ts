/**
 * useSubscription hook (V2) - Now uses SessionContext for zero-flicker experience
 * 
 * This provides the same interface as the original useSubscription
 * but uses pre-loaded entitlements from the unified session.
 */
import { useSubscriptionCompat } from "@/contexts/SessionContext";

// Re-export types for backward compatibility
export type { SessionOrganization } from "@/contexts/SessionContext";

export interface PlanFeature {
  feature_key: string;
  is_enabled: boolean;
  limit_value: number | null;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  description: string | null;
  price_monthly: number;
  price_yearly: number | null;
  features: string[];
  max_users: number | null;
  max_invoices_per_month: number | null;
  max_organizations: number;
}

export interface SubscriptionStatus {
  isActive: boolean;
  isSuspended: boolean;
  isTrialing: boolean;
  isExpired: boolean;
  status: string | null;
  trialEndsAt: string | null;
  subscriptionEndsAt: string | null;
  suspendedReason: string | null;
  daysRemaining: number | null;
  subscriptionType: 'trial' | 'active' | 'expired' | 'suspended' | 'cancelled' | 'none';
}

export interface SubscriptionUsage {
  invoices_count: number;
  users_count: number;
  pos_transactions_count: number;
  storage_used_mb: number;
  api_calls_count: number;
}

/**
 * New subscription hook that uses SessionContext
 * Provides the same interface as the original for backward compatibility
 */
export function useSubscription() {
  return useSubscriptionCompat();
}
