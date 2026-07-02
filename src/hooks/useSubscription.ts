/**
 * useSubscription hook - Redirects to SessionContext-based V2 implementation
 * 
 * This provides zero-flicker experience by using pre-loaded entitlements
 * from the unified session data fetched at login.
 */
export {
  useSubscription,
  type PlanFeature,
  type SubscriptionPlan,
  type SubscriptionStatus,
  type SubscriptionUsage,
  type SessionOrganization,
} from "./useSubscriptionV2";
