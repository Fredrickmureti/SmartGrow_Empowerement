import { useEffect, useRef, useContext } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { BusinessContext } from "@/contexts/BusinessContext";
import { queryKeys, getAllProductQueryKeys } from "@/lib/queryKeys";
import { syncManager } from "@/services/offline";
import type { POSProduct } from "./pos/usePOSProducts";

/**
 * Centralized hook for real-time product synchronization
 * 
 * This hook:
 * 1. Subscribes to ALL product changes for the organization
 * 2. Updates ALL product-related query caches (POS, Products page, paginated, etc.)
 * 3. Updates IndexedDB cache for Electron offline support
 * 4. Handles subscription health and reconnection
 * 
 * Mount this hook ONCE at the app root level (in a provider or App.tsx)
 */
export function useProductRealtimeSync() {
  const queryClient = useQueryClient();
  const { currentOrg } = useOrganization();
  const businessCtx = useContext(BusinessContext);
  const currentBusiness = businessCtx?.currentBusiness ?? null;
  const subscriptionRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const isElectron = typeof window !== 'undefined' && !!window.pos;

  useEffect(() => {
    if (!currentOrg?.id || !currentBusiness?.id) return;

    // Clean up existing subscription
    if (subscriptionRef.current) {
      supabase.removeChannel(subscriptionRef.current);
    }

    // Stage 2 (zero-trust audit): subscription is narrowed by business_id
    // so cross-company tabs in the same workspace can never see each other's
    // product mutations — RLS gates the channel, and the filter avoids
    // useless cache thrash even before RLS evaluates.
    const businessId = currentBusiness.id;

    const channel = supabase
      .channel(`products-unified-realtime-${currentOrg.id}-${businessId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'products',
          filter: `business_id=eq.${businessId}`,
        },
        async (payload) => {
          const updatedProduct = payload.new as any;
          console.log('[Realtime] Product UPDATE received:', updatedProduct.id, updatedProduct.name);
          updateAllProductCaches(queryClient, currentOrg.id, businessId, updatedProduct, 'UPDATE');
          if (isElectron) {
            await updateElectronCache(updatedProduct);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'products',
          filter: `business_id=eq.${businessId}`,
        },
        async (payload) => {
          const newProduct = payload.new as any;
          console.log('[Realtime] Product INSERT received:', newProduct.id, newProduct.name);
          updateAllProductCaches(queryClient, currentOrg.id, businessId, newProduct, 'INSERT');
          if (isElectron) {
            await updateElectronCache(newProduct);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'products',
          filter: `business_id=eq.${businessId}`,
        },
        async (payload) => {
          const deletedProduct = payload.old as any;
          console.log('[Realtime] Product DELETE received:', deletedProduct.id);
          updateAllProductCaches(queryClient, currentOrg.id, businessId, deletedProduct, 'DELETE');
          if (isElectron) {
            await removeFromElectronCache(deletedProduct.id);
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // debug-level: this hook is mounted globally (RealtimeSyncProvider) so
          // the Electron POS IndexedDB cache stays warm even when the user is on
          // Payroll/HR/etc. It does NOT issue per-page DB reads — it's a single
          // long-lived WebSocket. Do not unmount per-app or offline cache drifts.
          console.debug('[Realtime] Products unified subscription active');
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          console.error('[Realtime] Products subscription failed:', status);
        }
      });

    subscriptionRef.current = channel;

    return () => {
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
        subscriptionRef.current = null;
      }
    };
  }, [currentOrg?.id, currentBusiness?.id, queryClient, isElectron]);

  return null; // This hook doesn't return anything, it just sets up subscriptions
}

/**
 * Update all product-related query caches with the new data
 */
function updateAllProductCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  orgId: string,
  businessId: string | null | undefined,
  product: any,
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
) {
  // Map DB product to POSProduct format
  const posProduct: POSProduct = {
    id: product.id,
    name: product.name,
    sku: product.sku,
    description: product.description,
    selling_price: product.unit_price || 0,
    cost_price: product.cost_price,
    tax_rate: product.tax_rate,
    stock_quantity: product.stock_quantity,
    category: product.type,
    image_url: product.image_url,
    is_active: product.is_active,
    track_inventory: product.track_inventory,
    reorder_level: product.reorder_level,
    tax_rate_id: product.tax_rate_id,
    tax_rate_name: null,
    etims_tax_code: null,
    base_uom_id: product.base_uom_id ?? null,
  };

  // Get all query keys that need updating
  const queryKeysToUpdate = [
    queryKeys.products.pos(orgId, businessId),
    queryKeys.products.posCache(orgId),
  ];

  queryKeysToUpdate.forEach((key) => {
    queryClient.setQueryData(key, (oldData: POSProduct[] | undefined) => {
      if (!oldData) return oldData;

      switch (eventType) {
        case 'INSERT':
          // Only add if it matches the current business filter
          if (product.business_id === businessId || product.business_id === null) {
            return [...oldData, posProduct].sort((a, b) => a.name.localeCompare(b.name));
          }
          return oldData;

        case 'UPDATE':
          return oldData.map((p) =>
            p.id === product.id
              ? {
                  ...p,
                  ...posProduct,
                }
              : p
          );

        case 'DELETE':
          return oldData.filter((p) => p.id !== product.id);

        default:
          return oldData;
      }
    });
  });

  // Also update the useProducts hook's cache (different structure)
  queryClient.setQueryData(
    queryKeys.products.list(orgId, businessId),
    (oldData: any[] | undefined) => {
      if (!oldData) return oldData;

      switch (eventType) {
        case 'INSERT':
          if (product.business_id === businessId) {
            return [...oldData, product].sort((a: any, b: any) => a.name.localeCompare(b.name));
          }
          return oldData;

        case 'UPDATE':
          return oldData.map((p: any) =>
            p.id === product.id ? { ...p, ...product } : p
          );

        case 'DELETE':
          return oldData.filter((p: any) => p.id !== product.id);

        default:
          return oldData;
      }
    }
  );

  // Invalidate paginated queries (they have complex filters, easier to refetch)
  queryClient.invalidateQueries({
    queryKey: ['products-paginated', orgId],
    refetchType: 'active',
  });
  // Audit fix: the products list reads on-hand from `products-list-stock`
  // (warehouse_stock-based, branch-true). New product INSERTs change the
  // id-set, and UPDATEs may shift on-hand visibility — invalidate so the
  // qty cell never goes stale after add/edit.
  queryClient.invalidateQueries({
    queryKey: ['products-list-stock'],
    refetchType: 'active',
  });
}

/**
 * Update Electron's IndexedDB cache with the new product data
 */
async function updateElectronCache(product: any) {
  try {
    const posProduct: POSProduct = {
      id: product.id,
      name: product.name,
      sku: product.sku,
      description: product.description,
      selling_price: product.unit_price || 0,
      cost_price: product.cost_price,
      tax_rate: product.tax_rate,
      stock_quantity: product.stock_quantity,
      category: product.type,
      image_url: product.image_url,
      is_active: product.is_active,
      track_inventory: product.track_inventory,
      reorder_level: product.reorder_level,
      tax_rate_id: product.tax_rate_id,
      tax_rate_name: null,
      base_uom_id: product.base_uom_id ?? null,
      etims_tax_code: null,
    };

    await syncManager.updateSingleProductInCache(posProduct);
    console.log('[Realtime] Updated IndexedDB cache for product:', product.id);
  } catch (error) {
    console.error('[Realtime] Failed to update IndexedDB cache:', error);
  }
}

/**
 * Remove a product from Electron's IndexedDB cache
 */
async function removeFromElectronCache(productId: string) {
  try {
    await syncManager.removeProductFromCache(productId);
    console.log('[Realtime] Removed product from IndexedDB cache:', productId);
  } catch (error) {
    console.error('[Realtime] Failed to remove product from IndexedDB cache:', error);
  }
}
