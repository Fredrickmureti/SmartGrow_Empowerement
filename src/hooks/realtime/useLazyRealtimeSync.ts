/**
 * Lazy Realtime Sync Hook
 * 
 * Subscribe to realtime updates only when data is being actively used.
 * Automatically unsubscribes after a period of inactivity to conserve resources.
 * 
 * Usage in entity hooks:
 * ```
 * export function useInvoices() {
 *   useLazyRealtimeSync('invoices');
 *   return useQuery(...);
 * }
 * ```
 */

import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { queryKeys } from "@/lib/queryKeys";

// Branch-scoped POS realtime tables — channel topic, server-side filter,
// and payload drop are all keyed by branch_id so a branch operator cannot
// receive (or trigger refetches for) commits that belong to another branch.
// Org-only subscriptions for these tables are a documented Wave-A leak
// (`docs/architecture/POS_BRANCH_ISOLATION.md`) and must stay branch-scoped.
const POS_BRANCH_SCOPED_TABLES = new Set([
  "pos_transactions",
  "pos_shifts",
  "pos_held_transactions",
  "pos_kitchen_orders",
  "pos_drawer_events",
  "pos_cash_movements",
]);
type RealtimeChannel = any;

// Subscription tracking map (shared across hook instances)
interface SubscriptionEntry {
  channel: RealtimeChannel;
  refCount: number;
  lastAccess: number;
  cleanupTimeout?: ReturnType<typeof setTimeout>;
}

const subscriptionMap = new Map<string, SubscriptionEntry>();

// Cleanup idle subscriptions after 5 minutes
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// Query key mappings for each table
const TABLE_QUERY_KEYS: Record<string, (orgId: string, businessId?: string | null) => (readonly unknown[])[]> = {
  invoices: (orgId, businessId) => [
    queryKeys.invoices.all(orgId),
    queryKeys.invoices.list(orgId, businessId),
  ],
  bills: (orgId, businessId) => [
    queryKeys.bills.all(orgId),
    queryKeys.bills.list(orgId, businessId),
  ],
  payments: (orgId, businessId) => [
    queryKeys.payments.all(orgId),
    queryKeys.payments.list(orgId, businessId),
  ],
  expenses: (orgId, businessId) => [
    queryKeys.expenses.all(orgId),
    queryKeys.expenses.list(orgId, businessId),
  ],
  sales_orders: (orgId, businessId) => [
    queryKeys.salesOrders.all(orgId),
    queryKeys.salesOrders.list(orgId, businessId),
  ],
  purchase_orders: (orgId, businessId) => [
    queryKeys.purchaseOrders.all(orgId),
    queryKeys.purchaseOrders.list(orgId, businessId),
  ],
  purchase_returns: (orgId, businessId) => [
    queryKeys.purchaseReturns.all(orgId),
    queryKeys.purchaseReturns.list(orgId, businessId),
  ],
  contacts: (orgId, businessId) => [
    queryKeys.contacts.all(orgId),
    queryKeys.contacts.list(orgId, businessId),
  ],
  crm_leads: (orgId, businessId) => [
    queryKeys.leads.all(orgId),
    queryKeys.leads.list(orgId, businessId),
  ],
  products: (orgId, businessId) => [
    queryKeys.products.all(orgId),
    queryKeys.products.list(orgId, businessId),
  ],
  employees: (orgId, businessId) => [
    queryKeys.employees.all(orgId),
    queryKeys.employees.list(orgId, businessId),
  ],
  leave_requests: (orgId, businessId) => [
    queryKeys.leaveRequests.all(orgId),
    queryKeys.leaveRequests.list(orgId, businessId),
  ],
  projects: (orgId, businessId) => [
    queryKeys.projects.all(orgId),
    queryKeys.projects.list(orgId, businessId),
  ],
  stock_movements: (orgId, businessId) => [
    queryKeys.stockMovements.all(orgId),
    queryKeys.stockMovements.list(orgId, businessId),
  ],
  estimates: (orgId, businessId) => [
    queryKeys.estimates.all(orgId),
    queryKeys.estimates.list(orgId, businessId),
  ],
  delivery_notes: (orgId, businessId) => [
    queryKeys.deliveryNotes.all(orgId),
    queryKeys.deliveryNotes.list(orgId, businessId),
  ],
  budgets: (orgId, businessId) => [
    queryKeys.budgets.all(orgId),
    queryKeys.budgets.list(orgId, businessId),
  ],
  pos_transactions: (orgId) => [
    ["pos-transactions", orgId],
  ],
  pos_shifts: (orgId) => [
    ["pos-shifts", orgId],
  ],
};

/**
 * Hook for lazy realtime subscriptions
 * 
 * @param tableName - The database table to subscribe to
 * @param options - Configuration options
 */
export function useLazyRealtimeSync(
  tableName: string,
  options: {
    /** Disable auto-cleanup for always-on subscriptions */
    persistent?: boolean;
    /** Custom cleanup timeout in ms */
    idleTimeout?: number;
  } = {}
): void {
  const { persistent = false, idleTimeout = IDLE_TIMEOUT_MS } = options;
  
  const queryClient = useQueryClient();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const mountedRef = useRef(true);

  const branchScopeRequired = POS_BRANCH_SCOPED_TABLES.has(tableName);
  const branchId = currentBranch?.id ?? null;

  const getSubscriptionKey = useCallback(() => {
    if (branchScopeRequired) {
      // Branch-keyed topic so a context switch establishes a fresh
      // subscription and never reuses another branch's channel.
      return `${tableName}-${currentOrg?.id}-${branchId ?? "no-branch"}`;
    }
    return `${tableName}-${currentOrg?.id}`;
  }, [tableName, currentOrg?.id, branchScopeRequired, branchId]);

  // Create or reuse subscription
  const ensureSubscription = useCallback(() => {
    if (!currentOrg?.id) return null;
    // For branch-scoped POS tables, refuse to subscribe without a branch
    // context — HQ-overseer dashboards open their own org-wide channel via
    // a dedicated hook (not this one) so we never accidentally fan an
    // org-wide event into a branch operator's cache.
    if (branchScopeRequired && !branchId) return null;

    const key = getSubscriptionKey();
    let entry = subscriptionMap.get(key);

    if (entry) {
      // Increment ref count and update access time
      entry.refCount++;
      entry.lastAccess = Date.now();
      
      // Clear any pending cleanup
      if (entry.cleanupTimeout) {
        clearTimeout(entry.cleanupTimeout);
        entry.cleanupTimeout = undefined;
      }
      
      return entry;
    }

    // Server-side filter: org always, branch when applicable. Postgres
    // changes only support a single `filter` predicate, so we keep org
    // here and re-check branch in the payload handler below.
    const channel = supabase
      .channel(`lazy-${key}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: tableName,
          filter: `organization_id=eq.${currentOrg.id}`,
        },
        (payload) => {
          // Drop foreign-branch payloads for branch-scoped POS tables so
          // we never invalidate a branch operator's React Query cache for
          // another branch's commit (which would also be a side-channel
          // leak of activity timing).
          if (branchScopeRequired) {
            const row =
              (payload.new as Record<string, unknown> | null) ??
              (payload.old as Record<string, unknown> | null);
            const payloadBranch = (row?.branch_id as string | null) ?? null;
            if (payloadBranch && payloadBranch !== branchId) return;
          }

          console.log(`[LazyRealtime] ${tableName} ${payload.eventType}`);

          const getQueryKeys = TABLE_QUERY_KEYS[tableName];
          if (getQueryKeys) {
            const keys = getQueryKeys(currentOrg.id, currentBusiness?.id);
            keys.forEach((queryKey) => {
              queryClient.invalidateQueries({
                queryKey: queryKey as unknown[],
                refetchType: 'active',
              });
            });
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log(`[LazyRealtime] ${tableName} subscription active`);
        }
      });

    entry = {
      channel,
      refCount: 1,
      lastAccess: Date.now(),
    };

    subscriptionMap.set(key, entry);
    return entry;
  }, [currentOrg?.id, currentBusiness?.id, tableName, queryClient, getSubscriptionKey]);

  // Release subscription
  const releaseSubscription = useCallback(() => {
    const key = getSubscriptionKey();
    const entry = subscriptionMap.get(key);

    if (!entry) return;

    entry.refCount--;

    if (entry.refCount <= 0 && !persistent) {
      // Schedule cleanup after idle timeout
      entry.cleanupTimeout = setTimeout(() => {
        const currentEntry = subscriptionMap.get(key);
        if (currentEntry && currentEntry.refCount <= 0) {
          console.log(`[LazyRealtime] Cleaning up idle ${tableName} subscription`);
          supabase.removeChannel(currentEntry.channel);
          subscriptionMap.delete(key);
        }
      }, idleTimeout);
    }
  }, [getSubscriptionKey, tableName, persistent, idleTimeout]);

  useEffect(() => {
    mountedRef.current = true;
    ensureSubscription();

    return () => {
      mountedRef.current = false;
      releaseSubscription();
    };
  }, [ensureSubscription, releaseSubscription]);
}

/**
 * Get the current number of active subscriptions (for monitoring)
 */
export function getActiveSubscriptionCount(): number {
  return subscriptionMap.size;
}

/**
 * Force cleanup all idle subscriptions (for testing/debugging)
 */
export function cleanupAllIdleSubscriptions(): void {
  const now = Date.now();
  
  subscriptionMap.forEach((entry, key) => {
    if (entry.refCount <= 0 && now - entry.lastAccess > IDLE_TIMEOUT_MS) {
      console.log(`[LazyRealtime] Force cleanup: ${key}`);
      supabase.removeChannel(entry.channel);
      subscriptionMap.delete(key);
    }
  });
}

export default useLazyRealtimeSync;
