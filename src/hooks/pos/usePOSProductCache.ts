import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { syncManager } from "@/services/offline";
import { queryKeys } from "@/lib/queryKeys";
import type { POSProduct } from "./usePOSProducts";

/**
 * Hook for managing cached products with offline support
 * Now includes real-time subscription for instant updates
 */
export function usePOSProductCache() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const [cachedProducts, setCachedProducts] = useState<POSProduct[]>([]);
  const [isCacheReady, setIsCacheReady] = useState(false);

  // Fetch products from server (when online)
  const { data: serverProducts = [], isLoading, refetch } = useQuery({
    queryKey: [...queryKeys.products.posCache(currentOrg?.id || ''), currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("status", "active")
        .order("name");

      if (error) throw error;

      return data.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        description: p.description,
        selling_price: p.unit_price || 0,
        cost_price: p.cost_price,
        tax_rate: p.tax_rate,
        stock_quantity: p.stock_quantity,
        category: p.type,
        image_url: p.image_url,
        is_active: p.is_active,
        track_inventory: p.track_inventory,
        reorder_level: p.reorder_level,
        tax_rate_id: p.tax_rate_id,
        tax_rate_name: null,
        etims_tax_code: null,
      })) as POSProduct[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id && navigator.onLine,
    staleTime: 30000, // 30 seconds
  });

  // Load cached products on mount
  useEffect(() => {
    const loadCache = async () => {
      try {
        const cached = await syncManager.getCachedProducts();
        if (cached.length > 0) {
          setCachedProducts(cached);
          setIsCacheReady(true);
        }
      } catch (error) {
        console.error("Failed to load cached products:", error);
      }
    };

    loadCache();
  }, []);

  // Update cache when server products change
  useEffect(() => {
    if (serverProducts.length > 0) {
      setCachedProducts(serverProducts);
      setIsCacheReady(true);
    }
  }, [serverProducts]);

  // Real-time subscription for stock updates (mirrors usePOSProducts pattern)
  useEffect(() => {
    if (!currentOrg?.id || !currentBusiness?.id) return;

    const channel = supabase
      .channel('pos-products-cache-realtime')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'products',
          // Audit fix: scope by business_id so a second company in the same
          // workspace doesn't churn this tab's POS cache.
          filter: `business_id=eq.${currentBusiness.id}`,
        },
        (payload) => {
          const updatedProduct = payload.new as any;
          console.log('[POS Cache Realtime] Product UPDATE:', updatedProduct.id);

          // Update query cache
          queryClient.setQueryData(
            queryKeys.products.posCache(currentOrg.id),
            (oldProducts: POSProduct[] | undefined) => {
              if (!oldProducts) return oldProducts;
              return oldProducts.map((p) =>
                p.id === updatedProduct.id
                  ? {
                      ...p,
                      stock_quantity: updatedProduct.stock_quantity,
                      selling_price: updatedProduct.unit_price || p.selling_price,
                      cost_price: updatedProduct.cost_price,
                      tax_rate: updatedProduct.tax_rate,
                      is_active: updatedProduct.is_active,
                      track_inventory: updatedProduct.track_inventory,
                      reorder_level: updatedProduct.reorder_level,
                    }
                  : p
              );
            }
          );

          // Also update local state for immediate reactivity
          setCachedProducts((prev) =>
            prev.map((p) =>
              p.id === updatedProduct.id
                ? {
                    ...p,
                    stock_quantity: updatedProduct.stock_quantity,
                    selling_price: updatedProduct.unit_price || p.selling_price,
                    cost_price: updatedProduct.cost_price,
                    tax_rate: updatedProduct.tax_rate,
                    is_active: updatedProduct.is_active,
                    track_inventory: updatedProduct.track_inventory,
                    reorder_level: updatedProduct.reorder_level,
                  }
                : p
            )
          );
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'products',
          filter: `business_id=eq.${currentBusiness.id}`,
        },
        (payload) => {
          const newProduct = payload.new as any;
          if (!newProduct.is_active) return;

          const posProduct: POSProduct = {
            id: newProduct.id,
            name: newProduct.name,
            sku: newProduct.sku,
            description: newProduct.description,
            selling_price: newProduct.unit_price || 0,
            cost_price: newProduct.cost_price,
            tax_rate: newProduct.tax_rate,
            stock_quantity: newProduct.stock_quantity,
            category: newProduct.type,
            image_url: newProduct.image_url,
            is_active: newProduct.is_active,
            track_inventory: newProduct.track_inventory,
            reorder_level: newProduct.reorder_level,
            tax_rate_id: newProduct.tax_rate_id,
            tax_rate_name: null,
            etims_tax_code: null,
          };

          queryClient.setQueryData(
            queryKeys.products.posCache(currentOrg.id),
            (oldProducts: POSProduct[] | undefined) => {
              if (!oldProducts) return [posProduct];
              return [...oldProducts, posProduct].sort((a, b) => a.name.localeCompare(b.name));
            }
          );

          setCachedProducts((prev) =>
            [...prev, posProduct].sort((a, b) => a.name.localeCompare(b.name))
          );
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'products',
          filter: `business_id=eq.${currentBusiness.id}`,
        },
        (payload) => {
          const deletedId = payload.old.id;

          queryClient.setQueryData(
            queryKeys.products.posCache(currentOrg.id),
            (oldProducts: POSProduct[] | undefined) => {
              if (!oldProducts) return oldProducts;
              return oldProducts.filter((p) => p.id !== deletedId);
            }
          );

          setCachedProducts((prev) => prev.filter((p) => p.id !== deletedId));
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[POS Cache] Real-time subscription active');
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentOrg?.id, currentBusiness?.id, queryClient]);

  // Get the best available products (server or cached)
  const products = serverProducts.length > 0 ? serverProducts : cachedProducts;

  // Force refresh cache from server
  const refreshCache = useCallback(async () => {
    if (!currentOrg?.id) return;
    await refetch();
    if (navigator.onLine) {
      await syncManager.cacheProducts(currentOrg.id);
    }
  }, [currentOrg?.id, refetch]);

  // Update local cache for stock changes (optimistic)
  const updateLocalStock = useCallback((productId: string, quantityChange: number) => {
    setCachedProducts((prev) =>
      prev.map((p) => {
        if (p.id === productId && p.track_inventory) {
          return {
            ...p,
            stock_quantity: Math.max(0, (p.stock_quantity || 0) - quantityChange),
          };
        }
        return p;
      })
    );
  }, []);

  return {
    products,
    isLoading: isLoading && !isCacheReady,
    isCacheReady,
    isFromCache: serverProducts.length === 0 && cachedProducts.length > 0,
    refreshCache,
    updateLocalStock,
  };
}
