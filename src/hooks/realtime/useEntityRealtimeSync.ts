import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";

export interface EntityRealtimeSyncConfig<T = any> {
  /** Database table name */
  tableName: string;
  /** Channel name prefix for uniqueness */
  channelPrefix: string;
  /** Function to get query keys that need updating */
  getQueryKeys: (orgId: string, businessId?: string | null) => (readonly unknown[])[];
  /** Optional: Map payload to entity format (for INSERT/UPDATE) */
  mapPayload?: (payload: any) => T;
  /** Optional: Filter by business_id when updating cache */
  filterByBusiness?: boolean;
  /** Optional: Custom handler for INSERT */
  onInsert?: (payload: any, queryClient: ReturnType<typeof useQueryClient>) => void;
  /** Optional: Custom handler for UPDATE */
  onUpdate?: (payload: any, queryClient: ReturnType<typeof useQueryClient>) => void;
  /** Optional: Custom handler for DELETE */
  onDelete?: (payload: any, queryClient: ReturnType<typeof useQueryClient>) => void;
}

/**
 * Factory hook for creating real-time sync subscriptions for any entity
 * 
 * Usage:
 * ```
 * const useInvoiceRealtimeSync = createEntityRealtimeSync({
 *   tableName: 'invoices',
 *   channelPrefix: 'invoices',
 *   getQueryKeys: (orgId, businessId) => [
 *     queryKeys.invoices.list(orgId, businessId),
 *     queryKeys.invoices.all(orgId),
 *   ],
 * });
 * ```
 */
export function createEntityRealtimeSync<T = any>(config: EntityRealtimeSyncConfig<T>) {
  return function useEntityRealtimeSync() {
    const queryClient = useQueryClient();
    const { currentOrg } = useOrganization();
    const { currentBusiness } = useBusinesses();
    const subscriptionRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

    useEffect(() => {
      if (!currentOrg?.id) return;

      // Clean up existing subscription
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
      }

      const channel = supabase
        .channel(`${config.channelPrefix}-realtime-${currentOrg.id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: config.tableName,
            filter: `organization_id=eq.${currentOrg.id}`,
          },
          (payload) => {
            console.log(`[Realtime] ${config.tableName} INSERT:`, payload.new?.id || 'new');
            
            if (config.onInsert) {
              config.onInsert(payload.new, queryClient);
            } else {
              // Default: invalidate all related queries
              const queryKeys = config.getQueryKeys(currentOrg.id, currentBusiness?.id);
              queryKeys.forEach((key) => {
                queryClient.invalidateQueries({ queryKey: key as unknown[] });
              });
            }
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: config.tableName,
            filter: `organization_id=eq.${currentOrg.id}`,
          },
          (payload) => {
            console.log(`[Realtime] ${config.tableName} UPDATE:`, payload.new?.id);
            
            if (config.onUpdate) {
              config.onUpdate(payload.new, queryClient);
            } else {
              // Default: update cache in place or invalidate
              const queryKeys = config.getQueryKeys(currentOrg.id, currentBusiness?.id);
              const mappedData = config.mapPayload ? config.mapPayload(payload.new) : payload.new;
              
              queryKeys.forEach((key) => {
                queryClient.setQueryData(key as unknown[], (oldData: T[] | undefined) => {
                  if (!oldData || !Array.isArray(oldData)) {
                    // If no cache exists, invalidate to trigger refetch
                    queryClient.invalidateQueries({ queryKey: key as unknown[] });
                    return oldData;
                  }
                  
                  return oldData.map((item: any) =>
                    item.id === payload.new?.id ? { ...item, ...mappedData } : item
                  );
                });
              });
            }
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'DELETE',
            schema: 'public',
            table: config.tableName,
            filter: `organization_id=eq.${currentOrg.id}`,
          },
          (payload) => {
            console.log(`[Realtime] ${config.tableName} DELETE:`, payload.old?.id);
            
            if (config.onDelete) {
              config.onDelete(payload.old, queryClient);
            } else {
              // Default: remove from cache
              const queryKeys = config.getQueryKeys(currentOrg.id, currentBusiness?.id);
              
              queryKeys.forEach((key) => {
                queryClient.setQueryData(key as unknown[], (oldData: T[] | undefined) => {
                  if (!oldData || !Array.isArray(oldData)) return oldData;
                  return oldData.filter((item: any) => item.id !== payload.old?.id);
                });
              });
            }
          }
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            console.log(`[Realtime] ${config.tableName} subscription active`);
          } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
            console.error(`[Realtime] ${config.tableName} subscription failed:`, status);
          }
        });

      subscriptionRef.current = channel;

      return () => {
        if (subscriptionRef.current) {
          supabase.removeChannel(subscriptionRef.current);
          subscriptionRef.current = null;
        }
      };
    }, [currentOrg?.id, currentBusiness?.id, queryClient]);

    return null;
  };
}

/**
 * Simple invalidation-based real-time sync
 * Use this when cache manipulation is complex or not needed
 */
export function createSimpleRealtimeSync(config: {
  tableName: string;
  channelPrefix: string;
  getQueryKeys: (orgId: string, businessId?: string | null) => (readonly unknown[])[];
}) {
  return function useSimpleRealtimeSync() {
    const queryClient = useQueryClient();
    const { currentOrg } = useOrganization();
    const { currentBusiness } = useBusinesses();
    const subscriptionRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

    useEffect(() => {
      if (!currentOrg?.id) return;

      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
      }

      const channel = supabase
        .channel(`${config.channelPrefix}-simple-${currentOrg.id}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: config.tableName,
            filter: `organization_id=eq.${currentOrg.id}`,
          },
          () => {
            console.log(`[Realtime] ${config.tableName} changed, invalidating queries`);
            const queryKeys = config.getQueryKeys(currentOrg.id, currentBusiness?.id);
            queryKeys.forEach((key) => {
              queryClient.invalidateQueries({ queryKey: key as unknown[] });
            });
          }
        )
        .subscribe();

      subscriptionRef.current = channel;

      return () => {
        if (subscriptionRef.current) {
          supabase.removeChannel(subscriptionRef.current);
          subscriptionRef.current = null;
        }
      };
    }, [currentOrg?.id, currentBusiness?.id, queryClient]);

    return null;
  };
}
