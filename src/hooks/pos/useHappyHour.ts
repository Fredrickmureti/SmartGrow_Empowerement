import { normalizeError } from "@/services/resilience";
/**
 * Happy Hour / Time-Based Pricing Hook
 * 
 * Manages automatic price adjustments based on time of day.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useSession } from "@/contexts/SessionContext";
import { toast } from "sonner";

export type DiscountType = "percentage" | "fixed_amount" | "fixed_price";

export interface HappyHour {
  id: string;
  organization_id: string;
  branch_id: string | null;
  name: string;
  description: string | null;
  discount_type: DiscountType;
  discount_value: number;
  start_time: string; // HH:MM:SS
  end_time: string; // HH:MM:SS
  days_of_week: number[]; // 0 = Sunday, 6 = Saturday
  is_active: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
  items?: HappyHourItem[];
}

export interface HappyHourItem {
  id: string;
  happy_hour_id: string;
  product_id: string;
  override_discount_type: DiscountType | null;
  override_discount_value: number | null;
  created_at?: string;
  product?: {
    id: string;
    name: string;
    unit_price: number;
  } | null;
}

export interface CreateHappyHourInput {
  name: string;
  description?: string;
  discount_type: DiscountType;
  discount_value: number;
  start_time: string;
  end_time: string;
  days_of_week?: number[];
  branch_id?: string;
  priority?: number;
}

export function useHappyHour(branchId?: string) {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  // Fetch all happy hours
  const happyHoursQuery = useQuery({
    queryKey: ["pos-happy-hours", orgId, branchId],
    queryFn: async () => {
      if (!orgId) return [];
      
      let query = supabase
        .from("pos_happy_hours")
        .select(`
          *,
          items:pos_happy_hour_items(
            *,
            product:products(id, name, unit_price)
          )
        `)
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .order("priority", { ascending: false });
      
      if (branchId) {
        query = query.or(`branch_id.eq.${branchId},branch_id.is.null`);
      }
      
      const { data, error } = await query;
      
      if (error) throw error;
      return data as HappyHour[];
    },
    enabled: !!orgId,
  });

  // Create happy hour
  const createHappyHour = useMutation({
    mutationFn: async (input: CreateHappyHourInput) => {
      if (!orgId) throw new Error("No organization selected");
      if (!businessId) throw new Error("Select a Company before creating happy hours");
      
      const { data, error } = await supabase
        .from("pos_happy_hours")
        .insert({
          organization_id: orgId,
          business_id: businessId,
          name: input.name,
          description: input.description || null,
          discount_type: input.discount_type,
          discount_value: input.discount_value,
          start_time: input.start_time,
          end_time: input.end_time,
          days_of_week: input.days_of_week || [0, 1, 2, 3, 4, 5, 6],
          branch_id: input.branch_id || null,
          priority: input.priority || 0,
          is_active: true,
        })
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-happy-hours", orgId] });
      toast.success("Happy hour created");
    },
    onError: (error) => {
      toast.error("Failed to create happy hour: " + normalizeError(error).message);
    },
  });

  // Update happy hour
  const updateHappyHour = useMutation({
    mutationFn: async ({ id, items, ...updates }: Partial<HappyHour> & { id: string }) => {
      const { data, error } = await supabase
        .from("pos_happy_hours")
        .update({ ...updates, updated_at: new Date().toISOString() } as any)
        .eq("id", id)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-happy-hours", orgId] });
      toast.success("Happy hour updated");
    },
    onError: (error) => {
      toast.error("Failed to update happy hour: " + normalizeError(error).message);
    },
  });

  // Delete happy hour
  const deleteHappyHour = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("pos_happy_hours")
        .delete()
        .eq("id", id);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-happy-hours", orgId] });
      toast.success("Happy hour deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete happy hour: " + normalizeError(error).message);
    },
  });

  // Add product to happy hour
  const addProductToHappyHour = useMutation({
    mutationFn: async ({
      happyHourId,
      productId,
      overrideDiscountType,
      overrideDiscountValue,
    }: {
      happyHourId: string;
      productId: string;
      overrideDiscountType?: DiscountType;
      overrideDiscountValue?: number;
    }) => {
      const { data, error } = await supabase
        .from("pos_happy_hour_items")
        .insert({
          happy_hour_id: happyHourId,
          product_id: productId,
          override_discount_type: overrideDiscountType || null,
          override_discount_value: overrideDiscountValue || null,
        })
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-happy-hours", orgId] });
      toast.success("Product added to happy hour");
    },
    onError: (error) => {
      toast.error("Failed to add product: " + normalizeError(error).message);
    },
  });

  // Remove product from happy hour
  const removeProductFromHappyHour = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase
        .from("pos_happy_hour_items")
        .delete()
        .eq("id", itemId);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-happy-hours", orgId] });
      toast.success("Product removed from happy hour");
    },
    onError: (error) => {
      toast.error("Failed to remove product: " + normalizeError(error).message);
    },
  });

  // Check if currently in happy hour
  const isHappyHourActive = (happyHour: HappyHour): boolean => {
    if (!happyHour.is_active) return false;
    
    const now = new Date();
    const currentDay = now.getDay();
    const currentTime = now.toTimeString().slice(0, 8);
    
    // Check if today is included
    if (!happyHour.days_of_week.includes(currentDay)) return false;
    
    // Handle time range (including overnight ranges)
    if (happyHour.start_time <= happyHour.end_time) {
      // Normal range (e.g., 16:00 to 19:00)
      return currentTime >= happyHour.start_time && currentTime <= happyHour.end_time;
    } else {
      // Overnight range (e.g., 22:00 to 02:00)
      return currentTime >= happyHour.start_time || currentTime <= happyHour.end_time;
    }
  };

  // Get currently active happy hours
  const getActiveHappyHours = (): HappyHour[] => {
    const happyHours = happyHoursQuery.data || [];
    return happyHours.filter(isHappyHourActive);
  };

  // Calculate discounted price for a product
  const getDiscountedPrice = (
    productId: string,
    originalPrice: number
  ): { price: number; happyHour: HappyHour | null; savings: number } => {
    const activeHappyHours = getActiveHappyHours();
    
    for (const hh of activeHappyHours) {
      // Check if product is specifically included
      const productItem = hh.items?.find(item => item.product_id === productId);
      
      // If happy hour has specific products and this isn't one, skip
      if (hh.items && hh.items.length > 0 && !productItem) continue;
      
      // Get discount settings (product override or happy hour default)
      const discountType = productItem?.override_discount_type || hh.discount_type;
      const discountValue = productItem?.override_discount_value ?? hh.discount_value;
      
      let discountedPrice: number;
      
      switch (discountType) {
        case "percentage":
          discountedPrice = originalPrice * (1 - discountValue / 100);
          break;
        case "fixed_amount":
          discountedPrice = Math.max(0, originalPrice - discountValue);
          break;
        case "fixed_price":
          discountedPrice = discountValue;
          break;
        default:
          continue;
      }
      
      return {
        price: Math.round(discountedPrice * 100) / 100,
        happyHour: hh,
        savings: Math.round((originalPrice - discountedPrice) * 100) / 100,
      };
    }
    
    return { price: originalPrice, happyHour: null, savings: 0 };
  };

  // Format time for display
  const formatTime = (time: string): string => {
    const [hours, minutes] = time.split(":");
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 || 12;
    return `${hour12}:${minutes} ${ampm}`;
  };

  // Get day names
  const getDayNames = (days: number[]): string => {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    if (days.length === 7) return "Every day";
    if (days.length === 5 && !days.includes(0) && !days.includes(6)) return "Weekdays";
    if (days.length === 2 && days.includes(0) && days.includes(6)) return "Weekends";
    return days.map(d => dayNames[d]).join(", ");
  };

  return {
    happyHours: happyHoursQuery.data || [],
    isLoading: happyHoursQuery.isLoading,
    createHappyHour,
    updateHappyHour,
    deleteHappyHour,
    addProductToHappyHour,
    removeProductFromHappyHour,
    isHappyHourActive,
    getActiveHappyHours,
    getDiscountedPrice,
    formatTime,
    getDayNames,
  };
}
