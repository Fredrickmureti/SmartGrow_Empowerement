import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { applyBranchFilter } from "@/lib/branchScope";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

/**
 * Supplier item terms — the single canonical item-pricing engine.
 *
 * Reads come from `supplier_item_terms` (keyed on the supplier *role*), while
 * writes go through the `vendor_pricelists` compatibility view, whose
 * INSTEAD OF triggers resolve the party (contact) to its supplier record.
 * The exposed shape stays party-keyed (`vendor_id`) for existing callers.
 */
export interface VendorPriceList {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  vendor_id: string;
  product_id: string;
  unit_price: number;
  currency: string;
  min_order_qty: number;
  lead_time_days: number;
  is_preferred: boolean;
  valid_from: string | null;
  valid_until: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type VendorPriceListWithRelations = VendorPriceList & {
  vendor: { id: string; name: string } | null;
  product: { id: string; name: string; sku: string | null } | null;
};

export function useVendorPriceLists(vendorId?: string, productId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const queryClient = useQueryClient();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: priceLists = [], isLoading } = useQuery({
    queryKey: ["vendor-pricelists", organizationId, businessId, branchId, vendorId, productId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];

      let query: any = (supabase as any)
        .from("supplier_item_terms")
        .select(`
          *,
          supplier:suppliers!inner(id, contact_id, contact:contacts!contact_id(id, name)),
          product:products!product_id(id, name, sku)
        `)
        .eq("business_id", businessId)
        .eq("is_active", true);

      // Branch-scoped: match this branch OR company-wide (NULL).
      query = applyBranchFilter(query, branchId);

      if (vendorId) query = query.eq("supplier.contact_id", vendorId);
      if (productId) query = query.eq("product_id", productId);

      const { data, error } = await query.order("created_at", { ascending: false });

      if (error) throw error;

      return ((data ?? []) as any[]).map((row): VendorPriceListWithRelations => ({
        id: row.id,
        organization_id: row.organization_id,
        business_id: row.business_id,
        branch_id: row.branch_id,
        vendor_id: row.supplier?.contact_id,
        product_id: row.product_id,
        unit_price: Number(row.unit_price ?? 0),
        currency: row.currency_code,
        min_order_qty: Number(row.min_order_qty ?? 1),
        lead_time_days: Number(row.lead_time_days ?? 0),
        is_preferred: Number(row.preferred_rank ?? 10) <= 1,
        valid_from: row.effective_from,
        valid_until: row.effective_to,
        notes: row.notes,
        is_active: row.is_active,
        created_at: row.created_at,
        updated_at: row.updated_at,
        vendor: row.supplier?.contact ?? null,
        product: row.product ?? null,
      }));
    },
    enabled: !!organizationId && !!businessId,
  });

  const createMutation = useMutation({
    mutationFn: async (
      input: Omit<VendorPriceList, "id" | "created_at" | "updated_at" | "organization_id" | "business_id" | "branch_id"> & {
        branch_id?: string | null;
      },
    ) => {
      if (!organizationId || !businessId) throw new Error("Missing organization or business");

      // Caller may explicitly pass branch_id=null for company-wide; otherwise default to active branch.
      const effectiveBranchId =
        input.branch_id === undefined ? branchId : input.branch_id;

      // If marking as preferred, unset other preferred for same product within the same branch scope.
      if (input.is_preferred) {
        let q: any = (supabase as any)
          .from("vendor_pricelists")
          .update({ is_preferred: false })
          .eq("organization_id", organizationId)
          .eq("business_id", businessId)
          .eq("product_id", input.product_id)
          .eq("is_preferred", true);
        if (effectiveBranchId === null) {
          q = q.is("branch_id", null);
        } else {
          q = q.eq("branch_id", effectiveBranchId);
        }
        await q;
      }

      const { data, error } = await (supabase as any)
        .from("vendor_pricelists")
        .insert({
          ...input,
          organization_id: organizationId,
          business_id: businessId,
          branch_id: effectiveBranchId,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-pricelists"] });
      toast.success("Price list entry created");
    },
    onError: (error: Error) => {
      toast.error(`Failed to create: ${normalizeError(error).message}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...updates }: Partial<VendorPriceList> & { id: string }) => {
      // If marking as preferred, unset other preferred for same product within the same branch scope.
      if (updates.is_preferred) {
        const entry = priceLists.find((p) => p.id === id);
        if (entry) {
          let q: any = (supabase as any)
            .from("vendor_pricelists")
            .update({ is_preferred: false })
            .eq("organization_id", organizationId)
            .eq("business_id", businessId)
            .eq("product_id", entry.product_id)
            .eq("is_preferred", true)
            .neq("id", id);
          if (entry.branch_id === null) q = q.is("branch_id", null);
          else q = q.eq("branch_id", entry.branch_id);
          await q;
        }
      }

      const { error } = await (supabase as any)
        .from("vendor_pricelists")
        .update(updates)
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-pricelists"] });
      toast.success("Price list entry updated");
    },
    onError: (error: Error) => {
      toast.error(`Failed to update: ${normalizeError(error).message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("vendor_pricelists")
        .update({ is_active: false })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-pricelists"] });
      toast.success("Price list entry removed");
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete: ${normalizeError(error).message}`);
    },
  });

  // Get preferred vendor price for a product (branch-aware: prefers branch override, else company-wide)
  const getPreferredPrice = (pid: string) => {
    const candidates = priceLists.filter((p) => p.product_id === pid && p.is_preferred);
    return (
      candidates.find((p) => branchId && p.branch_id === branchId) ||
      candidates.find((p) => p.branch_id === null) ||
      candidates[0]
    );
  };

  return {
    priceLists,
    isLoading,
    createPriceList: createMutation.mutate,
    updatePriceList: updateMutation.mutate,
    deletePriceList: deleteMutation.mutate,
    getPreferredPrice,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
  };
}
