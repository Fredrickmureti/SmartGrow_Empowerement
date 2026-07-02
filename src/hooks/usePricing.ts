import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

export interface PriceListItem {
  id: string;
  price_list_id: string;
  product_id: string;
  unit_price: number;
  min_quantity: number;
}

export interface PriceList {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  is_active: boolean;
  valid_from: string | null;
  valid_to: string | null;
  applies_to_branches: string[] | null;
}

interface CustomerPricingContext {
  customerId?: string;
  priceListId?: string | null;
  customerGroupId?: string | null;
  customerGroupName?: string | null;
}

interface PriceResult {
  price: number;
  source: "customer_price_list" | "group_price_list" | "volume_break" | "default";
  priceListName?: string;
  originalPrice: number;
  discount: number;
  discountPercent: number;
}

export function usePricing() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  // Fetch all active price lists with their items
  const { data: priceLists = [], isLoading: loadingPriceLists } = useQuery({
    queryKey: ["price-lists", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];

      let q = supabase
        .from("price_lists")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true);
      q = q.eq("business_id", currentBusiness!.id);
      const { data, error } = await q;
      if (error) throw error;
      return data as PriceList[];
    },
    enabled: !!currentOrg?.id,
  });

  // Fetch all price list items
  const { data: priceListItems = [], isLoading: loadingItems } = useQuery({
    queryKey: ["price-list-items", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];

      // Get all price list IDs for this org
      const priceListIds = priceLists.map((pl) => pl.id);
      if (priceListIds.length === 0) return [];

      const { data, error } = await supabase
        .from("price_list_items")
        .select("*")
        .in("price_list_id", priceListIds);

      if (error) throw error;
      return data as PriceListItem[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id && priceLists.length > 0,
  });

  // Get customer's pricing context
  const getCustomerPricingContext = async (
    customerId: string
  ): Promise<CustomerPricingContext> => {
    if (!currentOrg?.id || !currentBusiness?.id) return { customerId };

    const { data, error } = await supabase
      .from("contacts")
      .select("price_list_id, customer_group_id, customer_groups:customer_group_id(name)")
      .eq("id", customerId)
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .single();

    if (error) {
      console.error("Error fetching customer pricing context:", error);
      return { customerId };
    }

    const groupRel = (data as any)?.customer_groups;
    const groupName = Array.isArray(groupRel) ? groupRel[0]?.name : groupRel?.name;

    return {
      customerId,
      priceListId: data?.price_list_id as string | null,
      customerGroupId: data?.customer_group_id as string | null,
      customerGroupName: (groupName as string | undefined) ?? null,
    };
  };

  // Main pricing function with cascade logic
  const getProductPrice = (
    productId: string,
    defaultPrice: number,
    quantity: number = 1,
    context?: CustomerPricingContext
  ): PriceResult => {
    const now = new Date().toISOString();

    // Filter valid price lists (check dates)
    const validPriceLists = priceLists.filter((pl) => {
      if (pl.valid_from && pl.valid_from > now) return false;
      if (pl.valid_to && pl.valid_to < now) return false;
      return true;
    });

    // Priority 1: Customer's assigned price list
    if (context?.priceListId) {
      const customerPriceList = validPriceLists.find(
        (pl) => pl.id === context.priceListId
      );
      if (customerPriceList) {
        const items = priceListItems
          .filter(
            (item) =>
              item.price_list_id === customerPriceList.id &&
              item.product_id === productId &&
              quantity >= item.min_quantity
          )
          .sort((a, b) => b.min_quantity - a.min_quantity);

        if (items.length > 0) {
          const bestPrice = items[0];
          return {
            price: bestPrice.unit_price,
            source: "customer_price_list",
            priceListName: customerPriceList.name,
            originalPrice: defaultPrice,
            discount: defaultPrice - bestPrice.unit_price,
            discountPercent:
              defaultPrice > 0
                ? ((defaultPrice - bestPrice.unit_price) / defaultPrice) * 100
                : 0,
          };
        }
      }
    }

    // Priority 2: Customer group price list (find price list matching group name)
    if (context?.customerGroupName) {
      const groupPriceList = validPriceLists.find(
        (pl) =>
          pl.name.toLowerCase().includes(context.customerGroupName!.toLowerCase()) ||
          pl.description?.toLowerCase().includes(context.customerGroupName!.toLowerCase())
      );

      if (groupPriceList) {
        const items = priceListItems
          .filter(
            (item) =>
              item.price_list_id === groupPriceList.id &&
              item.product_id === productId &&
              quantity >= item.min_quantity
          )
          .sort((a, b) => b.min_quantity - a.min_quantity);

        if (items.length > 0) {
          const bestPrice = items[0];
          return {
            price: bestPrice.unit_price,
            source: "group_price_list",
            priceListName: groupPriceList.name,
            originalPrice: defaultPrice,
            discount: defaultPrice - bestPrice.unit_price,
            discountPercent:
              defaultPrice > 0
                ? ((defaultPrice - bestPrice.unit_price) / defaultPrice) * 100
                : 0,
          };
        }
      }
    }

    // Priority 3: Volume breaks from default price list
    const defaultPriceList = validPriceLists.find((pl) => pl.is_default);
    if (defaultPriceList) {
      const items = priceListItems
        .filter(
          (item) =>
            item.price_list_id === defaultPriceList.id &&
            item.product_id === productId &&
            quantity >= item.min_quantity
        )
        .sort((a, b) => b.min_quantity - a.min_quantity);

      if (items.length > 0) {
        const bestPrice = items[0];
        return {
          price: bestPrice.unit_price,
          source: "volume_break",
          priceListName: defaultPriceList.name,
          originalPrice: defaultPrice,
          discount: defaultPrice - bestPrice.unit_price,
          discountPercent:
            defaultPrice > 0
              ? ((defaultPrice - bestPrice.unit_price) / defaultPrice) * 100
              : 0,
        };
      }
    }

    // Priority 4: Default product price
    return {
      price: defaultPrice,
      source: "default",
      originalPrice: defaultPrice,
      discount: 0,
      discountPercent: 0,
    };
  };

  // Get all prices for a product at different quantities
  const getProductPriceTiers = (
    productId: string,
    defaultPrice: number,
    context?: CustomerPricingContext
  ): Array<{ minQuantity: number; price: number; source: string }> => {
    const tiers: Array<{ minQuantity: number; price: number; source: string }> = [];

    // Get all applicable price list items for this product
    let applicablePriceLists: string[] = [];

    if (context?.priceListId) {
      applicablePriceLists.push(context.priceListId);
    }

    const defaultPriceList = priceLists.find((pl) => pl.is_default);
    if (defaultPriceList) {
      applicablePriceLists.push(defaultPriceList.id);
    }

    const items = priceListItems
      .filter(
        (item) =>
          applicablePriceLists.includes(item.price_list_id) &&
          item.product_id === productId
      )
      .sort((a, b) => a.min_quantity - b.min_quantity);

    // Add default tier
    tiers.push({ minQuantity: 1, price: defaultPrice, source: "default" });

    // Add price list tiers
    for (const item of items) {
      const priceList = priceLists.find((pl) => pl.id === item.price_list_id);
      tiers.push({
        minQuantity: item.min_quantity,
        price: item.unit_price,
        source: priceList?.name || "Price List",
      });
    }

    // Remove duplicates and sort
    const uniqueTiers = tiers.reduce((acc, tier) => {
      const existing = acc.find((t) => t.minQuantity === tier.minQuantity);
      if (!existing || tier.price < existing.price) {
        return [
          ...acc.filter((t) => t.minQuantity !== tier.minQuantity),
          tier,
        ];
      }
      return acc;
    }, [] as typeof tiers);

    return uniqueTiers.sort((a, b) => a.minQuantity - b.minQuantity);
  };

  return {
    priceLists,
    priceListItems,
    isLoading: loadingPriceLists || loadingItems,
    getProductPrice,
    getProductPriceTiers,
    getCustomerPricingContext,
  };
}
