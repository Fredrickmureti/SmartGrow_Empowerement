import { normalizeError } from "@/services/resilience";
/**
 * Order Modifiers Hook
 * 
 * Manages product modifiers (add-ons, customizations) for restaurant mode.
 * Examples: "Extra cheese", "No onions", "Well done", etc.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useSession } from "@/contexts/SessionContext";
import { toast } from "sonner";

export interface ModifierGroup {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  selection_type: "single" | "multiple";
  min_selections: number;
  max_selections: number | null;
  is_required: boolean;
  is_active: boolean;
  sort_order: number;
  modifiers?: Modifier[];
}

export interface Modifier {
  id: string;
  organization_id: string;
  modifier_group_id: string;
  name: string;
  price_adjustment: number;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface ProductModifierGroup {
  id: string;
  product_id: string;
  modifier_group_id: string;
  sort_order: number;
  modifier_group?: ModifierGroup;
}

export interface SelectedModifier {
  modifier_id: string;
  modifier_name: string;
  price_adjustment: number;
}

export function useModifiers(productId?: string) {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  // Fetch all modifier groups for the organization
  const modifierGroupsQuery = useQuery({
    queryKey: ["pos-modifier-groups", orgId, businessId],
    queryFn: async () => {
      if (!orgId || !businessId) return [];
      
      const { data, error } = await supabase
        .from("pos_modifier_groups")
        .select(`
          *,
          modifiers:pos_modifiers(*)
        `)
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .eq("is_active", true)
        .order("sort_order");
      
      if (error) throw error;
      return data as ModifierGroup[];
    },
    enabled: !!orgId && !!businessId,
  });

  // Fetch modifier groups for a specific product
  const productModifierGroupsQuery = useQuery({
    queryKey: ["pos-product-modifier-groups", productId],
    queryFn: async () => {
      if (!productId) return [];
      
      const { data, error } = await supabase
        .from("pos_product_modifier_groups")
        .select(`
          *,
          modifier_group:pos_modifier_groups(
            *,
            modifiers:pos_modifiers(*)
          )
        `)
        .eq("product_id", productId)
        .order("sort_order");
      
      if (error) throw error;
      return data as ProductModifierGroup[];
    },
    enabled: !!productId,
  });

  // Create modifier group
  const createModifierGroup = useMutation({
    mutationFn: async (input: Omit<ModifierGroup, "id" | "organization_id" | "modifiers">) => {
      if (!orgId || !businessId) throw new Error("No company selected");
      
      const { data, error } = await supabase
        .from("pos_modifier_groups")
        .insert({ ...input, organization_id: orgId, business_id: businessId })
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-modifier-groups", orgId, businessId] });
      toast.success("Modifier group created");
    },
    onError: (error) => {
      toast.error("Failed to create modifier group: " + normalizeError(error).message);
    },
  });

  // Create modifier
  const createModifier = useMutation({
    mutationFn: async (input: Omit<Modifier, "id" | "organization_id">) => {
      if (!orgId || !businessId) throw new Error("No company selected");
      
      const { data, error } = await supabase
        .from("pos_modifiers")
        .insert({ ...input, organization_id: orgId, business_id: businessId })
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-modifier-groups", orgId, businessId] });
      toast.success("Modifier created");
    },
    onError: (error) => {
      toast.error("Failed to create modifier: " + normalizeError(error).message);
    },
  });

  // Link modifier group to product
  const linkModifierGroupToProduct = useMutation({
    mutationFn: async ({ productId, modifierGroupId, sortOrder = 0 }: {
      productId: string;
      modifierGroupId: string;
      sortOrder?: number;
    }) => {
      const { data, error } = await supabase
        .from("pos_product_modifier_groups")
        .insert({
          product_id: productId,
          modifier_group_id: modifierGroupId,
          sort_order: sortOrder,
        })
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["pos-product-modifier-groups", variables.productId] });
      toast.success("Modifier group linked to product");
    },
    onError: (error) => {
      toast.error("Failed to link modifier group: " + normalizeError(error).message);
    },
  });

  // Unlink modifier group from product
  const unlinkModifierGroupFromProduct = useMutation({
    mutationFn: async ({ productId, modifierGroupId }: {
      productId: string;
      modifierGroupId: string;
    }) => {
      const { error } = await supabase
        .from("pos_product_modifier_groups")
        .delete()
        .eq("product_id", productId)
        .eq("modifier_group_id", modifierGroupId);
      
      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["pos-product-modifier-groups", variables.productId] });
      toast.success("Modifier group removed from product");
    },
    onError: (error) => {
      toast.error("Failed to unlink modifier group: " + normalizeError(error).message);
    },
  });

  // Update modifier group
  const updateModifierGroup = useMutation({
    mutationFn: async ({ id, modifiers, ...updates }: Partial<ModifierGroup> & { id: string }) => {
      const { data, error } = await supabase
        .from("pos_modifier_groups")
        .update({ ...updates, updated_at: new Date().toISOString() } as any)
        .eq("id", id)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-modifier-groups", orgId, businessId] });
      toast.success("Modifier group updated");
    },
    onError: (error) => {
      toast.error("Failed to update modifier group: " + normalizeError(error).message);
    },
  });

  // Update modifier
  const updateModifier = useMutation({
    mutationFn: async ({ id, ...updates }: Partial<Modifier> & { id: string }) => {
      const { data, error } = await supabase
        .from("pos_modifiers")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-modifier-groups", orgId, businessId] });
      toast.success("Modifier updated");
    },
    onError: (error) => {
      toast.error("Failed to update modifier: " + normalizeError(error).message);
    },
  });

  // Delete modifier group
  const deleteModifierGroup = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("pos_modifier_groups")
        .delete()
        .eq("id", id);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-modifier-groups", orgId, businessId] });
      toast.success("Modifier group deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete modifier group: " + normalizeError(error).message);
    },
  });

  // Delete modifier
  const deleteModifier = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("pos_modifiers")
        .delete()
        .eq("id", id);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-modifier-groups", orgId, businessId] });
      toast.success("Modifier deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete modifier: " + normalizeError(error).message);
    },
  });

  // Calculate total price adjustment for selected modifiers
  const calculateModifiersTotal = (selectedModifiers: SelectedModifier[]): number => {
    return selectedModifiers.reduce((sum, mod) => sum + mod.price_adjustment, 0);
  };

  // Validate modifier selection against group rules
  const validateSelection = (
    group: ModifierGroup,
    selectedCount: number
  ): { valid: boolean; message?: string } => {
    if (group.is_required && selectedCount === 0) {
      return { valid: false, message: `Please select at least one ${group.name}` };
    }
    if (group.min_selections > 0 && selectedCount < group.min_selections) {
      return { valid: false, message: `Select at least ${group.min_selections} ${group.name}` };
    }
    if (group.max_selections && selectedCount > group.max_selections) {
      return { valid: false, message: `Select at most ${group.max_selections} ${group.name}` };
    }
    return { valid: true };
  };

  return {
    modifierGroups: modifierGroupsQuery.data || [],
    productModifierGroups: productModifierGroupsQuery.data || [],
    isLoading: modifierGroupsQuery.isLoading || productModifierGroupsQuery.isLoading,
    createModifierGroup,
    createModifier,
    updateModifierGroup,
    updateModifier,
    deleteModifierGroup,
    deleteModifier,
    linkModifierGroupToProduct,
    unlinkModifierGroupFromProduct,
    calculateModifiersTotal,
    validateSelection,
  };
}
