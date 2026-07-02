/**
 * Real-time sync hooks
 * 
 * Architecture:
 * - useUnifiedRealtimeSync: Finance-critical tables (global, always-on for auth'd users)
 * - useLazyRealtimeSync: On-demand subscriptions for non-finance modules
 * - useProductRealtimeSync: Dedicated product handler (IndexedDB + cache, global)
 * 
 * Legacy individual hooks have been removed — they were dead code never imported.
 */

export { useUnifiedRealtimeSync } from "./useUnifiedRealtimeSync";
export { useLazyRealtimeSync, getActiveSubscriptionCount, cleanupAllIdleSubscriptions } from "./useLazyRealtimeSync";
export { createEntityRealtimeSync, createSimpleRealtimeSync } from "./useEntityRealtimeSync";
