import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "./use-toast";
import { normalizeError } from "@/services/resilience";

export interface ProductCategory {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  color: string | null;
  is_active: boolean;
  created_at: string;
  /** Category-level GL accounts (ADR 0122). Null = inherit from parent/company. */
  sales_account_id: string | null;
  purchase_account_id: string | null;
  cogs_account_id: string | null;
  inventory_account_id: string | null;
}

/** Category-level GL account overrides accepted by create/update. */
export interface CategoryAccountInput {
  sales_account_id?: string | null;
  purchase_account_id?: string | null;
  cogs_account_id?: string | null;
  inventory_account_id?: string | null;
}

export interface CategoryTreeNode extends ProductCategory {
  children: CategoryTreeNode[];
  depth: number;
  fullPath: string;
}

export function useProductCategories() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const queryKey = ["product-categories", organizationId, businessId];

  const { data: categories = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!organizationId || !businessId) return [];

      const { data, error } = await supabase
        .from("product_categories")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .eq("is_active", true)
        .order("name");

      if (error) throw error;
      return data as ProductCategory[];
    },
    enabled: !!organizationId && !!businessId,
  });

  // Build hierarchical tree from flat list
  const categoryTree = buildCategoryTree(categories);

  // Flat list with depth info for dropdowns
  const flatTreeList = flattenTree(categoryTree);

  const createMutation = useMutation({
    mutationFn: async (input: { name: string; description?: string; parent_id?: string | null; color?: string } & CategoryAccountInput) => {
      if (!organizationId) throw new Error("No organization selected");

      const { data, error } = await supabase
        .from("product_categories")
        .insert({
          organization_id: organizationId,
            business_id: businessId,
          name: input.name,
          description: input.description || null,
          parent_id: input.parent_id || null,
          color: input.color || null,
          sales_account_id: input.sales_account_id ?? null,
          purchase_account_id: input.purchase_account_id ?? null,
          cogs_account_id: input.cogs_account_id ?? null,
          inventory_account_id: input.inventory_account_id ?? null,
        })
        .select()
        .single();

      if (error) throw error;
      return data as ProductCategory;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error: any) => {
      // Map the Wave 11 unique-index violation to an actionable message.
      const raw = normalizeError(error).message;
      const isUniqueViolation =
        error?.code === "23505" ||
        /product_categories_unique_active_name|duplicate key/i.test(raw);
      toast({
        title: "Error creating category",
        description: isUniqueViolation
          ? "A category with that name already exists at this level."
          : raw,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...updates }: { id: string; name?: string; description?: string | null; parent_id?: string | null; color?: string | null; is_active?: boolean } & CategoryAccountInput) => {
      const { error } = await supabase
        .from("product_categories")
        .update(updates)
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error: any) => {
      toast({
        title: "Error updating category",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      // Check if any products use this category
      const { count } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("category_id", id);

      if (count && count > 0) {
        throw new Error(`Cannot delete: ${count} product(s) are using this category. Reassign them first.`);
      }

      // Check if any child categories exist
      const { count: childCount } = await supabase
        .from("product_categories")
        .select("id", { count: "exact", head: true })
        .eq("parent_id", id);

      if (childCount && childCount > 0) {
        throw new Error("Cannot delete: this category has subcategories. Delete or move them first.");
      }

      const { error } = await supabase
        .from("product_categories")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error: any) => {
      toast({
        title: "Error deleting category",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  return {
    categories,
    categoryTree,
    flatTreeList,
    isLoading,
    createCategory: createMutation.mutateAsync,
    updateCategory: updateMutation.mutateAsync,
    deleteCategory: deleteMutation.mutateAsync,
    isCreating: createMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}

function buildCategoryTree(categories: ProductCategory[]): CategoryTreeNode[] {
  const map = new Map<string, CategoryTreeNode>();
  const roots: CategoryTreeNode[] = [];

  // Initialize nodes
  for (const cat of categories) {
    map.set(cat.id, { ...cat, children: [], depth: 0, fullPath: cat.name });
  }

  // Build tree
  for (const cat of categories) {
    const node = map.get(cat.id)!;
    if (cat.parent_id && map.has(cat.parent_id)) {
      const parent = map.get(cat.parent_id)!;
      node.depth = parent.depth + 1;
      node.fullPath = `${parent.fullPath} / ${cat.name}`;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function flattenTree(nodes: CategoryTreeNode[]): CategoryTreeNode[] {
  const result: CategoryTreeNode[] = [];
  function walk(list: CategoryTreeNode[]) {
    for (const node of list) {
      result.push(node);
      walk(node.children);
    }
  }
  walk(nodes);
  return result;
}
