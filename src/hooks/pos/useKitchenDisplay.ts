import { normalizeError } from "@/services/resilience";
/**
 * Kitchen Display System Hook
 * 
 * Manages kitchen orders with real-time updates for restaurant mode.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useEffect } from "react";
import { toast } from "sonner";

export interface KitchenOrder {
  id: string;
  organization_id: string;
  business_id: string | null;
  transaction_id: string;
  transaction_item_id: string | null;
  course_id: string | null;
  printer_category: "kitchen" | "bar" | "dessert" | "grill";
  status: "new" | "sent" | "cooking" | "ready" | "served" | "cancelled";
  priority: number;
  notes: string | null;
  table_number: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  // Joined data
  transaction?: {
    id: string;
    transaction_number: string;
    table_session_id: string | null;
  };
  transaction_item?: {
    id: string;
    description: string;
    quantity: number;
  } | null;
  items?: KitchenOrderItem[];
}

export interface KitchenOrderItem {
  id: string;
  product_name: string;
  quantity: number;
  notes: string | null;
}

export interface CreateKitchenOrderInput {
  transaction_id: string;
  transaction_item_id?: string;
  course_id?: string;
  printer_category: "kitchen" | "bar" | "dessert" | "grill";
  notes?: string;
  table_number?: string;
  priority?: number;
}

export function useKitchenDisplay(category?: string) {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  // Stage B6 branch isolation: KDS tickets carry branch_id; never leak
  // another branch's open orders into this terminal.
  const { currentBranch } = useBranch();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  // Fetch active kitchen orders
  const ordersQuery = useQuery({
    queryKey: ["pos-kitchen-orders", orgId, bizId, branchId, category],
    queryFn: async () => {
      if (!orgId || !bizId) return [];
      
      let query = supabase
        .from("pos_kitchen_orders")
        .select(`
          *,
          transaction:pos_transactions(
            id, 
            transaction_number, 
            table_session_id
          ),
          transaction_item:pos_transaction_items(
            id,
            description,
            quantity
          )
        `)
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .in("status", ["new", "sent", "cooking"])
        .order("priority", { ascending: false })
        .order("created_at", { ascending: true });

      if (branchId) {
        query = query.eq("branch_id", branchId);
      }
      
      if (category && category !== "all") {
        query = query.eq("printer_category", category);
      }
      
      const { data, error } = await query;
      
      if (error) throw error;
      return data as KitchenOrder[];
    },
    enabled: !!orgId && !!bizId,
    refetchInterval: 5000, // Refresh every 5 seconds as backup
  });

  // Set up real-time subscription
  useEffect(() => {
    if (!orgId) return;

    const channel = supabase
      .channel(
        `kitchen-orders-realtime-${orgId}-${bizId ?? 'no-business'}-${branchId ?? 'no-branch'}`,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "pos_kitchen_orders",
          filter: `organization_id=eq.${orgId}`,
        },
        (payload) => {
          // Stage B6: defensively drop payloads outside the active branch.
          const newRow = payload.new as { branch_id?: string | null; business_id?: string | null } | null;
          const oldRow = payload.old as { branch_id?: string | null; business_id?: string | null } | null;
          const payloadBranch = newRow?.branch_id ?? oldRow?.branch_id ?? null;
          const payloadBiz = newRow?.business_id ?? oldRow?.business_id ?? null;
          if (bizId && payloadBiz && payloadBiz !== bizId) return;
          if (branchId && payloadBranch && payloadBranch !== branchId) return;
          queryClient.invalidateQueries({ queryKey: ["pos-kitchen-orders", orgId] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [orgId, bizId, branchId, queryClient]);

  // Create kitchen order
  const createOrder = useMutation({
    mutationFn: async (input: CreateKitchenOrderInput) => {
      if (!orgId) throw new Error("No organization selected");
      if (!bizId) throw new Error("No company selected");
      if (!branchId) throw new Error("Select a branch before sending to the kitchen");
      
      const { data, error } = await supabase
        .from("pos_kitchen_orders")
        .insert({
          organization_id: orgId,
          business_id: bizId,
          branch_id: branchId,
          transaction_id: input.transaction_id,
          transaction_item_id: input.transaction_item_id || null,
          course_id: input.course_id || null,
          printer_category: input.printer_category,
          notes: input.notes || null,
          table_number: input.table_number || null,
          priority: input.priority || 0,
          status: "new",
        } as any)
        .select()
        .single();
      
      if (error) throw error;
      return data as KitchenOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-kitchen-orders", orgId] });
    },
    onError: (error) => {
      toast.error("Failed to send to kitchen: " + normalizeError(error).message);
    },
  });

  // Start preparing order
  const startOrder = useMutation({
    mutationFn: async (orderId: string) => {
      const { data, error } = await supabase
        .from("pos_kitchen_orders")
        .update({
          status: "cooking",
          started_at: new Date().toISOString(),
        })
        .eq("id", orderId)
        .select()
        .single();
      
      if (error) throw error;
      return data as KitchenOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-kitchen-orders", orgId] });
    },
  });

  // Mark order as ready
  const completeOrder = useMutation({
    mutationFn: async (orderId: string) => {
      const { data, error } = await supabase
        .from("pos_kitchen_orders")
        .update({
          status: "ready",
          completed_at: new Date().toISOString(),
        })
        .eq("id", orderId)
        .select()
        .single();
      
      if (error) throw error;
      return data as KitchenOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-kitchen-orders", orgId] });
      // Play notification sound
      try {
        const audio = new Audio("/sounds/order-ready.mp3");
        audio.play().catch(() => {}); // Ignore if no audio support
      } catch {
        // Ignore audio errors
      }
    },
  });

  // Mark order as served
  const serveOrder = useMutation({
    mutationFn: async (orderId: string) => {
      const { data, error } = await supabase
        .from("pos_kitchen_orders")
        .update({
          status: "served",
        })
        .eq("id", orderId)
        .select()
        .single();
      
      if (error) throw error;
      return data as KitchenOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-kitchen-orders", orgId] });
    },
  });

  // Cancel order
  const cancelOrder = useMutation({
    mutationFn: async (orderId: string) => {
      const { data, error } = await supabase
        .from("pos_kitchen_orders")
        .update({
          status: "cancelled",
        })
        .eq("id", orderId)
        .select()
        .single();
      
      if (error) throw error;
      return data as KitchenOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-kitchen-orders", orgId] });
      toast.success("Order cancelled");
    },
  });

  // Bump priority
  const bumpPriority = useMutation({
    mutationFn: async (orderId: string) => {
      const { data, error } = await supabase
        .from("pos_kitchen_orders")
        .update({
          priority: 1, // High priority
        })
        .eq("id", orderId)
        .select()
        .single();
      
      if (error) throw error;
      return data as KitchenOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-kitchen-orders", orgId] });
      toast.success("Order bumped to priority");
    },
  });

  // Get order counts by status
  const getOrderCounts = () => {
    const orders = ordersQuery.data || [];
    return {
      pending: orders.filter(o => o.status === "new" || o.status === "sent").length,
      in_progress: orders.filter(o => o.status === "cooking").length,
      ready: orders.filter(o => o.status === "ready").length,
      total: orders.length,
    };
  };

  // Get average wait time
  const getAverageWaitTime = () => {
    const orders = ordersQuery.data || [];
    if (orders.length === 0) return 0;
    
    const now = new Date();
    const totalWait = orders.reduce((sum, order) => {
      const createdAt = new Date(order.created_at);
      return sum + (now.getTime() - createdAt.getTime());
    }, 0);
    
    return Math.round(totalWait / orders.length / 60000); // Minutes
  };

  return {
    orders: ordersQuery.data || [],
    isLoading: ordersQuery.isLoading,
    createOrder,
    startOrder,
    completeOrder,
    serveOrder,
    cancelOrder,
    bumpPriority,
    getOrderCounts,
    getAverageWaitTime,
  };
}
