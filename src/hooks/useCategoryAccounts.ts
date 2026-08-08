/**
 * useCategoryAccounts — the category tier of the product GL ladder (ADR 0122).
 *
 * Categories are few per tenant, so the whole set is loaded once and the
 * parent_id chain is walked in memory by `resolveCategoryAccount`.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import type { CategoryAccountNode } from "@/lib/productCategoryAccounts";

export function useCategoryAccounts() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;

  const { data, isLoading } = useQuery({
    queryKey: ["category-accounts", orgId],
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<CategoryAccountNode[]> => {
      const { data, error } = await supabase
        .from("product_categories")
        .select(
          "id, name, parent_id, sales_account_id, purchase_account_id, cogs_account_id, inventory_account_id",
        )
        .eq("organization_id", orgId!);
      if (error) throw error;
      return (data as CategoryAccountNode[]) || [];
    },
  });

  return { categories: data ?? [], isLoading };
}
