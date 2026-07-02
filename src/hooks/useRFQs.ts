import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";

export interface RFQ {
  id: string;
  organization_id: string;
  business_id: string | null;
  rfq_number: string;
  status: string;
  deadline: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RFQItem {
  id?: string;
  rfq_id?: string;
  product_id: string | null;
  description: string;
  quantity: number;
  target_price: number | null;
  sort_order: number;
}

export interface RFQVendor {
  id: string;
  rfq_id: string;
  vendor_id: string;
  status: string;
  quoted_total: number | null;
  lead_time_days: number | null;
  notes: string | null;
  responded_at: string | null;
  vendor?: { id: string; name: string } | null;
}

export interface RFQVendorItem {
  id?: string;
  rfq_vendor_id: string;
  rfq_item_id: string;
  unit_price: number | null;
  available_qty: number | null;
}

export type RFQWithRelations = RFQ & {
  items?: RFQItem[];
  vendors?: (RFQVendor & { vendor: { id: string; name: string } | null })[];
};

export function useRFQs() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: rfqs = [], isLoading } = useQuery({
    queryKey: ["rfqs", organizationId, businessId, branchId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];

      let q = (supabase as any)
        .from("rfqs")
        .select(`
          *,
          items:rfq_items(*),
          vendors:rfq_vendors(*, vendor:contacts!vendor_id(id, name))
        `)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });
      q = applyBranchFilter(q, branchId);
      const { data, error } = await q;
      if (error) throw error;
      return data as RFQWithRelations[];
    },
    enabled: !!organizationId && !!businessId,
  });

  const getNextRFQNumber = async (): Promise<string> => {
    if (!organizationId) throw new Error("No organization");
    const { data, error } = await supabase.rpc("get_next_rfq_number", { _org_id: organizationId });
    if (error) throw error;
    return data;
  };

  const createRFQMutation = useMutation({
    mutationFn: async ({
      rfq,
      items,
      vendorIds,
    }: {
      rfq: { deadline: string | null; notes: string | null };
      items: Omit<RFQItem, "id" | "rfq_id">[];
      vendorIds: string[];
    }) => {
      if (!organizationId || !businessId || !user) throw new Error("Missing org, business, or user");

      const rfqNumber = await getNextRFQNumber();

      // Create RFQ — strict business scope (Phase 10 audit fix)
      const { data: created, error: rfqError } = await (supabase as any)
        .from("rfqs")
        .insert({
          organization_id: organizationId,
          business_id: businessId,
          branch_id: branchId,
          rfq_number: rfqNumber,
          status: "draft",
          deadline: rfq.deadline || null,
          notes: rfq.notes || null,
          created_by: user.id,
        })
        .select()
        .single();

      if (rfqError) throw rfqError;

      // Insert items
      if (items.length > 0) {
        const itemsToInsert = items.map((item, idx) => ({
          rfq_id: created.id,
          product_id: item.product_id,
          description: item.description,
          quantity: item.quantity,
          target_price: item.target_price,
          sort_order: idx,
        }));

        const { error: itemsError } = await (supabase as any)
          .from("rfq_items")
          .insert(itemsToInsert);
        if (itemsError) throw itemsError;
      }

      // Insert vendors
      if (vendorIds.length > 0) {
        const vendorsToInsert = vendorIds.map((vid) => ({
          rfq_id: created.id,
          vendor_id: vid,
          status: "pending",
        }));

        const { error: vendorsError } = await (supabase as any)
          .from("rfq_vendors")
          .insert(vendorsToInsert);
        if (vendorsError) throw vendorsError;
      }

      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      toast.success("RFQ created");
    },
    onError: (error: Error) => {
      toast.error(`Failed to create RFQ: ${normalizeError(error).message}`);
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await (supabase as any)
        .from("rfqs")
        .update({ status })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      toast.success("RFQ status updated");
    },
    onError: (error: Error) => {
      toast.error(`Failed to update: ${normalizeError(error).message}`);
    },
  });

  const updateVendorResponseMutation = useMutation({
    mutationFn: async ({
      rfqVendorId,
      status,
      quotedTotal,
      leadTimeDays,
      notes,
      itemResponses,
    }: {
      rfqVendorId: string;
      status: string;
      quotedTotal: number | null;
      leadTimeDays: number | null;
      notes: string | null;
      itemResponses?: Omit<RFQVendorItem, "id">[];
    }) => {
      const { error } = await (supabase as any)
        .from("rfq_vendors")
        .update({
          status,
          quoted_total: quotedTotal,
          lead_time_days: leadTimeDays,
          notes,
          responded_at: new Date().toISOString(),
        })
        .eq("id", rfqVendorId);
      if (error) throw error;

      // Upsert item responses
      if (itemResponses && itemResponses.length > 0) {
        // Delete existing
        await (supabase as any)
          .from("rfq_vendor_items")
          .delete()
          .eq("rfq_vendor_id", rfqVendorId);

        const { error: itemsError } = await (supabase as any)
          .from("rfq_vendor_items")
          .insert(itemResponses);
        if (itemsError) throw itemsError;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      toast.success("Vendor response recorded");
    },
    onError: (error: Error) => {
      toast.error(`Failed to record response: ${normalizeError(error).message}`);
    },
  });

  const awardVendorMutation = useMutation({
    mutationFn: async ({ rfqId, rfqVendorId }: { rfqId: string; rfqVendorId: string }) => {
      // Atomic award: locks the rfqs row (FOR UPDATE) inside the RPC so
      // two simultaneous awards on the same RFQ can't both succeed.
      const { error } = await supabase.rpc("award_rfq_atomic" as any, {
        _rfq_id: rfqId,
        _rfq_vendor_id: rfqVendorId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      toast.success("Vendor awarded");
    },
    onError: (error: Error) => {
      toast.error(`Failed to award: ${normalizeError(error).message}`);
    },
  });

  const deleteRFQMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("rfqs")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      toast.success("RFQ deleted");
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete: ${normalizeError(error).message}`);
    },
  });

  const convertToPurchaseOrderMutation = useMutation({
    mutationFn: async ({ rfqId, rfqVendorId }: { rfqId: string; rfqVendorId: string }) => {
      if (!user) throw new Error("Missing user");
      // Atomic: PO header + lines + RFQ status flip in a single transaction.
      // Branch is inherited from the source RFQ inside the RPC.
      const { data, error } = await supabase.rpc("convert_rfq_to_po_atomic" as any, {
        _rfq_id: rfqId,
        _rfq_vendor_id: rfqVendorId,
        _user_id: user.id,
      });
      if (error) throw error;
      return data as { purchase_order_id: string; po_number: string };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
      toast.success(`Converted to Purchase Order ${data.po_number}`);
    },
    onError: (error: Error) => {
      toast.error(`Failed to convert: ${normalizeError(error).message}`);
    },
  });

  return {
    rfqs,
    isLoading,
    createRFQ: createRFQMutation.mutate,
    updateStatus: updateStatusMutation.mutate,
    updateVendorResponse: updateVendorResponseMutation.mutate,
    awardVendor: awardVendorMutation.mutate,
    convertToPurchaseOrder: convertToPurchaseOrderMutation.mutate,
    deleteRFQ: deleteRFQMutation.mutate,
    isCreating: createRFQMutation.isPending,
  };
}
