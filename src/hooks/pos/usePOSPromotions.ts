import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface Promotion {
  id: string;
  name: string;
  description: string | null;
  promotion_type: "percentage" | "fixed_amount" | "buy_x_get_y" | "bundle" | "tiered";
  discount_value: number | null;
  buy_quantity: number | null;
  get_quantity: number | null;
  bundle_price: number | null;
  valid_from: string;
  valid_to: string;
  is_active: boolean;
  applies_to: "all" | "category" | "product" | "customer_group";
  target_ids: string[] | null;
  min_purchase_amount: number | null;
  max_discount_amount: number | null;
  promo_code: string | null;
  stackable: boolean;
  priority: number;
}

export interface AppliedPromotion {
  promotion: Promotion;
  discountAmount: number;
  affectedItems: string[];
}

export function usePOSPromotions() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  // Fetch active promotions
  const { data: promotions = [], isLoading } = useQuery({
    queryKey: ["pos-promotions", organizationId, businessId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];

      const now = new Date().toISOString();

      const { data, error } = await supabase
        .from("promotions")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .eq("is_active", true)
        .lte("valid_from", now)
        .gte("valid_to", now)
        .order("priority", { ascending: false });

      if (error) {
        console.error("Error fetching promotions:", error);
        return [];
      }

      return data as Promotion[];
    },
    enabled: !!organizationId && !!businessId,
    staleTime: 60 * 1000, // Cache for 1 minute
  });

  /**
   * Evaluate promotions for cart items
   */
  const evaluatePromotions = (
    items: Array<{
      product_id: string;
      category_id?: string;
      quantity: number;
      unit_price: number;
      line_total: number;
    }>,
    subtotal: number,
    customerGroupId?: string
  ): AppliedPromotion[] => {
    const appliedPromotions: AppliedPromotion[] = [];
    const usedPromotions = new Set<string>();

    // Sort by priority (highest first)
    const sortedPromotions = [...promotions].sort((a, b) => b.priority - a.priority);

    for (const promotion of sortedPromotions) {
      // Skip if already used and not stackable
      if (!promotion.stackable && usedPromotions.size > 0) continue;
      if (usedPromotions.has(promotion.id)) continue;

      // Check minimum purchase amount
      if (promotion.min_purchase_amount && subtotal < promotion.min_purchase_amount) continue;

      // Determine affected items
      let affectedItems: typeof items = [];
      
      switch (promotion.applies_to) {
        case "all":
          affectedItems = items;
          break;
        case "product":
          if (promotion.target_ids) {
            affectedItems = items.filter(item => 
              promotion.target_ids!.includes(item.product_id)
            );
          }
          break;
        case "category":
          if (promotion.target_ids) {
            affectedItems = items.filter(item => 
              item.category_id && promotion.target_ids!.includes(item.category_id)
            );
          }
          break;
        case "customer_group":
          if (promotion.target_ids && customerGroupId) {
            if (promotion.target_ids.includes(customerGroupId)) {
              affectedItems = items;
            }
          }
          break;
      }

      if (affectedItems.length === 0) continue;

      let discountAmount = 0;

      switch (promotion.promotion_type) {
        case "percentage":
          if (promotion.discount_value) {
            const itemsTotal = affectedItems.reduce((sum, item) => sum + item.line_total, 0);
            discountAmount = itemsTotal * (promotion.discount_value / 100);
          }
          break;

        case "fixed_amount":
          if (promotion.discount_value) {
            discountAmount = promotion.discount_value;
          }
          break;

        case "buy_x_get_y":
          if (promotion.buy_quantity && promotion.get_quantity) {
            // Find qualifying items and calculate free items
            for (const item of affectedItems) {
              const sets = Math.floor(item.quantity / (promotion.buy_quantity + promotion.get_quantity));
              discountAmount += sets * promotion.get_quantity * item.unit_price;
            }
          }
          break;

        case "bundle":
          // Bundle pricing - if all target products are in cart, apply bundle price
          if (promotion.bundle_price && promotion.target_ids) {
            const allPresent = promotion.target_ids.every(targetId =>
              items.some(item => item.product_id === targetId)
            );
            if (allPresent) {
              const originalTotal = items
                .filter(item => promotion.target_ids!.includes(item.product_id))
                .reduce((sum, item) => sum + item.line_total, 0);
              discountAmount = Math.max(0, originalTotal - promotion.bundle_price);
            }
          }
          break;

        case "tiered":
          // Tiered discounts based on quantity or amount
          // Implementation would need additional tier configuration
          break;
      }

      // Apply max discount cap
      if (promotion.max_discount_amount) {
        discountAmount = Math.min(discountAmount, promotion.max_discount_amount);
      }

      if (discountAmount > 0) {
        appliedPromotions.push({
          promotion,
          discountAmount,
          affectedItems: affectedItems.map(item => item.product_id),
        });
        usedPromotions.add(promotion.id);
      }
    }

    return appliedPromotions;
  };

  /**
   * Validate a promo code
   */
  const validatePromoCode = (code: string): Promotion | null => {
    const now = new Date();
    return promotions.find(p => 
      p.promo_code?.toLowerCase() === code.toLowerCase() &&
      p.is_active &&
      new Date(p.valid_from) <= now &&
      new Date(p.valid_to) >= now
    ) || null;
  };

  return {
    promotions,
    isLoading,
    evaluatePromotions,
    validatePromoCode,
  };
}
