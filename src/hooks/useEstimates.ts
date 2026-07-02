import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { usePermissions } from "./usePermissions";
import { queryKeys } from "@/lib/queryKeys";
import { applyBranchFilter } from "@/lib/branchScope";

export interface EstimateItem {
  id?: string;
  estimate_id?: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number;
  discount_percent: number;
  line_total: number;
  sort_order: number;
  // UoM provenance — base `quantity` stays in base units; these record the
  // pack the operator entered. DB trigger normalizes server-side.
  packaging_id?: string | null;
  display_quantity?: number | null;
  display_uom_id?: string | null;
}

export interface AdditionalCost {
  id?: string;
  estimate_id?: string;
  name: string;
  amount: number;
  is_taxable: boolean;
  tax_rate: number;
  tax_amount: number;
  sort_order: number;
}

export interface Estimate {
  id: string;
  organization_id: string;
  contact_id: string | null;
  estimate_number: string;
  status: "draft" | "sent" | "viewed" | "accepted" | "rejected" | "expired" | "converted";
  issue_date: string;
  expiry_date: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  currency: string;
  notes: string | null;
  terms: string | null;
  converted_invoice_id: string | null;
  converted_at: string | null;
  customer_signature_url: string | null;
  signed_at: string | null;
  signed_by_name: string | null;
  signed_by_email: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  contact?: { name: string; email: string | null } | null;
  items?: EstimateItem[];
  additional_costs?: AdditionalCost[];
}

async function fetchEstimatesFn(orgId: string, businessId: string, branchId: string | null) {
  let query = supabase
    .from("estimates")
    .select(`
      *,
      contact:contacts(name, email),
      items:estimate_items(*)
    `)
    .eq("organization_id", orgId)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  query = applyBranchFilter(query, branchId);
  const { data, error } = await query;

  if (error) throw error;
  return (data as unknown as Estimate[]) || [];
}

export function useEstimates() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { can } = usePermissions();
  const queryClient = useQueryClient();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: estimates = [], isLoading } = useQuery({
    queryKey: [...queryKeys.estimates.list(orgId!, businessId), branchId],
    queryFn: () => fetchEstimatesFn(orgId!, businessId!, branchId),
    enabled: !!orgId && !!businessId,
  });

  const invalidate = useCallback(() => {
    if (!orgId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.estimates.all(orgId) });
  }, [queryClient, orgId]);

  const getNextEstimateNumber = async (): Promise<string> => {
    if (!currentOrg) throw new Error("No organization selected");
    const { data, error } = await supabase.rpc("get_next_estimate_number", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness?.id ?? null,
      _branch_id: currentBranch?.id ?? null,
    } as any);
    if (error) throw error;
    return data;
  };

  const createEstimate = async (
    estimate: Omit<Estimate, "id" | "organization_id" | "created_at" | "updated_at" | "created_by" | "contact" | "items" | "additional_costs">,
    items: Omit<EstimateItem, "id" | "estimate_id">[],
    additionalCosts?: Omit<AdditionalCost, "id" | "estimate_id">[]
  ) => {
    if (!can("manageSales")) { toast({ title: "Permission denied", description: "You don't have permission to create estimates", variant: "destructive" }); throw new Error("Permission denied"); }
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
    const itemsTax = items.reduce((sum, item) => sum + item.tax_amount, 0);
    const additionalCostsTotal = (additionalCosts || []).reduce((sum, cost) => sum + cost.amount, 0);
    const additionalCostsTax = (additionalCosts || []).reduce((sum, cost) => sum + cost.tax_amount, 0);
    const taxAmount = itemsTax + additionalCostsTax;
    const total = subtotal + taxAmount + additionalCostsTotal - (estimate.discount_amount || 0);

    const { data: created, error: estimateError } = await supabase
      .from("estimates")
      .insert({
        ...estimate,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: currentBranch?.id ?? null,
        created_by: user.id,
        subtotal,
        tax_amount: taxAmount,
        total,
      })
      .select()
      .single();

    if (estimateError) throw estimateError;

    if (items.length > 0) {
      const itemsToInsert = items.map((item, index) => ({
        ...item,
        estimate_id: created.id,
        sort_order: index,
      }));
      const { error: itemsError } = await supabase.from("estimate_items").insert(itemsToInsert);
      if (itemsError) throw itemsError;
    }

    if (additionalCosts && additionalCosts.length > 0) {
      const costsToInsert = additionalCosts.map((cost, index) => ({
        estimate_id: created.id,
        name: cost.name,
        amount: cost.amount,
        is_taxable: cost.is_taxable,
        tax_rate: cost.tax_rate,
        tax_amount: cost.tax_amount,
        sort_order: index,
      }));
      const { error: costsError } = await supabase.from("estimate_additional_costs").insert(costsToInsert);
      if (costsError) throw costsError;
    }

    logAction({
      action: "created",
      entityType: "estimate",
      entityId: created.id,
      entityName: estimate.estimate_number,
      changesSummary: `Created estimate ${estimate.estimate_number} for ${total}`,
    });

    invalidate();
    return created;
  };

  const updateEstimate = async (
    id: string,
    updates: Partial<Estimate>,
    items?: Omit<EstimateItem, "id" | "estimate_id">[]
  ) => {
    if (!can("manageSales")) { toast({ title: "Permission denied", description: "You don't have permission to update estimates", variant: "destructive" }); throw new Error("Permission denied"); }

    if (items) {
      const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
      const taxAmount = items.reduce((sum, item) => sum + item.tax_amount, 0);
      const total = subtotal + taxAmount - (updates.discount_amount || 0);

      updates.subtotal = subtotal;
      updates.tax_amount = taxAmount;
      updates.total = total;

      await supabase.from("estimate_items").delete().eq("estimate_id", id);

      if (items.length > 0) {
        const itemsToInsert = items.map((item, index) => ({
          ...item,
          estimate_id: id,
          sort_order: index,
        }));
        const { error: itemsError } = await supabase.from("estimate_items").insert(itemsToInsert);
        if (itemsError) throw itemsError;
      }
    }

    const { additional_costs: _ac, contact: _c, items: _i, ...dbUpdates } = updates as any;

    const { error } = await supabase.from("estimates").update(dbUpdates).eq("id", id);
    if (error) throw error;

    const estimate = estimates.find((e) => e.id === id);
    if (estimate) {
      logAction({
        action: "updated",
        entityType: "estimate",
        entityId: id,
        entityName: estimate.estimate_number,
        changesSummary: `Updated estimate ${estimate.estimate_number}`,
      });
    }

    invalidate();
  };

  const deleteEstimate = async (id: string) => {
    if (!can("manageSales")) { toast({ title: "Permission denied", description: "You don't have permission to delete estimates", variant: "destructive" }); throw new Error("Permission denied"); }
    const estimate = estimates.find((e) => e.id === id);
    
    const { error } = await supabase.from("estimates").delete().eq("id", id);
    if (error) throw error;

    if (estimate) {
      logAction({
        action: "deleted",
        entityType: "estimate",
        entityId: id,
        entityName: estimate.estimate_number,
        changesSummary: `Deleted estimate ${estimate.estimate_number}`,
      });
    }

    invalidate();
  };

  const convertToInvoice = async (estimateId: string) => {
    const estimate = estimates.find((e) => e.id === estimateId);
    if (!estimate) throw new Error("Estimate not found");

    if ((estimate as any).converted_invoice_id) {
      throw new Error(`Estimate ${estimate.estimate_number} has already been converted to an invoice.`);
    }

    const convertibleStatuses = ["draft", "sent", "accepted", "approved"];
    if (!convertibleStatuses.includes(estimate.status)) {
      throw new Error(`Cannot convert estimate with status "${estimate.status}".`);
    }

    if (!user) throw new Error("Not authenticated");

    // Sales audit Phase B (finding #5 + #6): use atomic RPC. The DB function
    // sets source_estimate_id on the invoice, copies items verbatim with the
    // canonical tax-exclusive line_total convention, and flips the estimate
    // to 'converted' in a single transaction so we cannot get an invoice
    // without the estimate being marked converted.
    const { data, error } = await supabase.rpc("convert_estimate_to_invoice_atomic" as any, {
      p_estimate_id: estimateId,
      p_user_id: user.id,
    });
    if (error) throw error;
    const result = data as { success: boolean; invoice_id: string; invoice_number: string };
    if (!result?.success) throw new Error("Estimate conversion failed");

    invalidate();
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
    return { id: result.invoice_id, invoice_number: result.invoice_number };
  };

  const convertToSalesOrder = async (estimateId: string) => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    const estimate = estimates.find((e) => e.id === estimateId);
    if (!estimate) throw new Error("Estimate not found");

    // Sales audit Phase 2: atomic RPC. Single DB transaction creates the SO
    // header + items and flips the estimate to 'converted'. Replaces the
    // previous 3-step client orchestration that could leave half-converted state.
    const { data, error } = await supabase.rpc("convert_estimate_to_so_atomic" as any, {
      p_estimate_id: estimateId,
      p_user_id: user.id,
    });
    if (error) throw error;
    const result = data as { success: boolean; sales_order_id: string; so_number: string };
    if (!result?.success) throw new Error("Estimate → Sales Order conversion failed");

    logAction({
      action: "converted",
      entityType: "estimate",
      entityId: estimateId,
      entityName: estimate.estimate_number,
      changesSummary: `Converted estimate ${estimate.estimate_number} to sales order ${result.so_number}`,
    });

    toast({ title: "Success", description: `Converted to sales order ${result.so_number}` });
    invalidate();
    queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
    return { id: result.sales_order_id, so_number: result.so_number };
  };

  return {
    estimates,
    isLoading,
    getNextEstimateNumber,
    createEstimate,
    updateEstimate,
    deleteEstimate,
    convertToInvoice,
    convertToSalesOrder,
    refreshEstimates: invalidate,
  };
}
