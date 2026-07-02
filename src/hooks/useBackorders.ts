import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";

export interface Backorder {
  id: string;
  organization_id: string;
  sales_order_id: string;
  sales_order_item_id: string;
  product_id: string;
  quantity: number;
  status: "pending" | "allocated" | "fulfilled";
  created_at: string;
  allocated_at: string | null;
  fulfilled_at: string | null;
  sales_order?: {
    so_number: string;
    contact?: { name: string } | null;
  };
  product?: {
    name: string;
    sku: string | null;
  };
}

export function useBackorders() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [backorders, setBackorders] = useState<Backorder[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (currentOrg) {
      fetchBackorders();
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  const fetchBackorders = async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      let query = supabase
        .from("backorders" as any)
        .select(`
          *,
          sales_order:sales_orders(so_number, contact:contacts(name)),
          product:products(name, sku)
        `)
        .eq("organization_id", currentOrg.id);

      if (currentBusiness) {
        query = query.eq("business_id", currentBusiness.id);
      }

      const { data, error } = await query.order("created_at", { ascending: true });

      if (error) throw error;
      setBackorders((data || []) as unknown as Backorder[]);
    } catch (error) {
      console.error("Error fetching backorders:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const createBackorder = async (data: {
    salesOrderId: string;
    salesOrderItemId: string;
    productId: string;
    quantity: number;
  }) => {
    if (!currentOrg) return null;

    try {
      const { data: backorder, error } = await supabase
        .from("backorders" as any)
        .insert({
          organization_id: currentOrg.id,
          sales_order_id: data.salesOrderId,
          sales_order_item_id: data.salesOrderItemId,
          product_id: data.productId,
          quantity: data.quantity,
          status: "pending",
        })
        .select()
        .single();

      if (error) throw error;

      // Update sales order item with backordered quantity
      await supabase
        .from("sales_order_items")
        .update({
          quantity_backordered: data.quantity,
        } as any)
        .eq("id", data.salesOrderItemId);

      toast.success("Backorder created");
      await fetchBackorders();
      return backorder;
    } catch (error) {
      console.error("Error creating backorder:", error);
      toast.error("Failed to create backorder");
      return null;
    }
  };

  const allocateBackorder = async (backorderId: string) => {
    try {
      const { error } = await supabase
        .from("backorders" as any)
        .update({
          status: "allocated",
          allocated_at: new Date().toISOString(),
        })
        .eq("id", backorderId);

      if (error) throw error;
      toast.success("Backorder allocated");
      await fetchBackorders();
    } catch (error) {
      console.error("Error allocating backorder:", error);
      toast.error("Failed to allocate backorder");
    }
  };

  const fulfillBackorder = async (backorderId: string) => {
    try {
      const backorder = backorders.find((b) => b.id === backorderId);
      if (!backorder) throw new Error("Backorder not found");

      const { error } = await supabase
        .from("backorders" as any)
        .update({
          status: "fulfilled",
          fulfilled_at: new Date().toISOString(),
        })
        .eq("id", backorderId);

      if (error) throw error;

      await supabase
        .from("sales_order_items")
        .update({ quantity_backordered: 0 } as any)
        .eq("id", backorder.sales_order_item_id);

      toast.success("Backorder fulfilled");
      await fetchBackorders();
    } catch (error) {
      console.error("Error fulfilling backorder:", error);
      toast.error("Failed to fulfill backorder");
    }
  };

  const getBackorderQueue = async (productId: string): Promise<Backorder[]> => {
    if (!currentOrg) return [];

    const { data, error } = await supabase
      .from("backorders" as any)
      .select(`*, sales_order:sales_orders(so_number, contact:contacts(name))`)
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .eq("product_id", productId)
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (error) return [];
    return (data || []) as unknown as Backorder[];
  };

  const cancelBackorder = async (backorderId: string) => {
    try {
      const backorder = backorders.find((b) => b.id === backorderId);
      if (!backorder) throw new Error("Backorder not found");

      const { error } = await supabase
        .from("backorders" as any)
        .delete()
        .eq("id", backorderId);

      if (error) throw error;

      await supabase
        .from("sales_order_items")
        .update({ quantity_backordered: 0 } as any)
        .eq("id", backorder.sales_order_item_id);

      toast.success("Backorder cancelled");
      await fetchBackorders();
    } catch (error) {
      console.error("Error cancelling backorder:", error);
      toast.error("Failed to cancel backorder");
    }
  };

  return {
    backorders,
    isLoading,
    refresh: fetchBackorders,
    createBackorder,
    allocateBackorder,
    fulfillBackorder,
    cancelBackorder,
    getBackorderQueue,
  };
}
