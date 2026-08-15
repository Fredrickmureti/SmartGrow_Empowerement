import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { callRpcWithSchemaRetry } from "@/lib/rpcSchemaRetry";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { usePermissions } from "./usePermissions";
import { queryKeys } from "@/lib/queryKeys";
import { applyBranchFilter } from "@/lib/branchScope";
import { computeEstimateTotals, type EstimateStatus } from "@/lib/estimateLifecycle";
import { captureBillToSnapshot } from "@/lib/contactAddresses";
import { createEstimateAtomic, updateEstimateAtomic } from "@/hooks/estimates/estimateWriter";

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
  converted_sales_order_id: string | null;
  converted_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
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
    estimate: Omit<
      Estimate,
      | "id" | "organization_id" | "created_at" | "updated_at" | "created_by"
      | "contact" | "items" | "additional_costs"
      // Lifecycle timestamps and forward pointers are owned by the DB state
      // machine (`set_estimate_status_atomic` / conversion RPCs), never by a
      // creation form.
      | "converted_sales_order_id" | "sent_at" | "viewed_at" | "accepted_at" | "rejected_at"
    > &
      Partial<
        Pick<
          Estimate,
          "converted_sales_order_id" | "sent_at" | "viewed_at" | "accepted_at" | "rejected_at"
        >
      >,
    items: Omit<EstimateItem, "id" | "estimate_id">[],
    additionalCosts?: Omit<AdditionalCost, "id" | "estimate_id">[]
  ) => {
    if (!can("manageSales")) { toast({ title: "Permission denied", description: "You don't have permission to create estimates", variant: "destructive" }); throw new Error("Permission denied"); }
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    // Freeze the bill-to address on the document (Phase 5).
    const billTo = await captureBillToSnapshot(estimate.contact_id);

    // Phase 9: header + lines + additional costs are written by
    // `create_estimate_atomic` in one transaction. Totals, the exchange rate,
    // the document number and every line's base quantity are server-resolved;
    // the client totals below are preview only.
    const result = await createEstimateAtomic(
      {
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: currentBranch?.id ?? null,
        contact_id: estimate.contact_id ?? null,
        issue_date: estimate.issue_date ?? null,
        expiry_date: estimate.expiry_date ?? null,
        notes: estimate.notes ?? null,
        terms: estimate.terms ?? null,
        discount_amount: estimate.discount_amount ?? 0,
        // Callers that already allocated a number keep it, so
        // `get_next_estimate_number` never leaves a gap in the series.
        estimate_number: estimate.estimate_number ?? null,
        currency: estimate.currency ?? null,
        template_id: (estimate as { template_id?: string | null }).template_id ?? null,
        source_lead_id: (estimate as { source_lead_id?: string | null }).source_lead_id ?? null,
        ...billTo,
      },
      items.map((item, index) => ({
        product_id: item.product_id ?? null,
        description: item.description,
        quantity: item.quantity,
        display_quantity: item.display_quantity ?? null,
        display_uom_id: item.display_uom_id ?? null,
        packaging_id: item.packaging_id ?? null,
        unit_price: item.unit_price,
        discount_percent: item.discount_percent,
        tax_rate: item.tax_rate,
        sort_order: index,
      })),
      (additionalCosts ?? []).map((cost, index) => ({
        name: cost.name,
        amount: cost.amount,
        is_taxable: cost.is_taxable,
        tax_rate: cost.tax_rate,
        sort_order: index,
      })),
    );

    logAction({
      action: "created",
      entityType: "estimate",
      entityId: result.estimate_id,
      entityName: result.estimate_number,
      changesSummary: `Created estimate ${result.estimate_number} for ${result.total}`,
    });

    invalidate();
    return { id: result.estimate_id, estimate_number: result.estimate_number, total: result.total };
  };

  /**
   * Moves an estimate through the lifecycle. The DB owns the transition table
   * (`set_estimate_status_atomic`); a trigger rejects any direct status write,
   * so this RPC is the only legal path.
   */
  const setEstimateStatus = async (id: string, status: EstimateStatus, reason?: string) => {
    if (!can("manageSales")) { toast({ title: "Permission denied", description: "You don't have permission to update estimates", variant: "destructive" }); throw new Error("Permission denied"); }
    if (!user) throw new Error("Not authenticated");

    const { error } = await callRpcWithSchemaRetry(() =>
      supabase.rpc("set_estimate_status_atomic" as any, {
        p_estimate_id: id,
        p_status: status,
        p_user_id: user.id,
        p_reason: reason ?? null,
      }),
    );
    if (error) throw error;

    const estimate = estimates.find((e) => e.id === id);
    logAction({
      action: "status_changed",
      entityType: "estimate",
      entityId: id,
      entityName: estimate?.estimate_number ?? id,
      changesSummary: `Estimate status → ${status}`,
    });

    invalidate();
  };

  const updateEstimate = async (
    id: string,
    updates: Partial<Estimate>,
    items?: Omit<EstimateItem, "id" | "estimate_id">[],
    additionalCosts?: Omit<AdditionalCost, "id" | "estimate_id">[]
  ) => {
    if (!can("manageSales")) { toast({ title: "Permission denied", description: "You don't have permission to update estimates", variant: "destructive" }); throw new Error("Permission denied"); }

    const costs = additionalCosts ?? (updates.additional_costs as AdditionalCost[] | undefined);

    const { additional_costs: _ac, contact: _c, items: _i, status: nextStatus, ...dbUpdates } = updates as any;

    // Phase 9: one server transaction owns header + lines + costs. The
    // governed-write triggers reject any direct DML on estimate lines, and the
    // server recomputes every total from the resolved lines.
    await updateEstimateAtomic(
      id,
      {
        contact_id: dbUpdates.contact_id ?? null,
        issue_date: dbUpdates.issue_date ?? null,
        expiry_date: dbUpdates.expiry_date ?? null,
        notes: dbUpdates.notes ?? null,
        terms: dbUpdates.terms ?? null,
        discount_amount: dbUpdates.discount_amount ?? null,
        template_id: dbUpdates.template_id ?? null,
        bill_to_contact_id: dbUpdates.bill_to_contact_id ?? null,
        billing_address: dbUpdates.billing_address ?? null,
      },
      items?.map((item, index) => ({
        product_id: item.product_id ?? null,
        description: item.description,
        quantity: item.quantity,
        display_quantity: item.display_quantity ?? null,
        display_uom_id: item.display_uom_id ?? null,
        packaging_id: item.packaging_id ?? null,
        unit_price: item.unit_price,
        discount_percent: item.discount_percent,
        tax_rate: item.tax_rate,
        sort_order: index,
      })),
      costs?.map((cost, index) => ({
        name: cost.name,
        amount: cost.amount,
        is_taxable: cost.is_taxable,
        tax_rate: cost.tax_rate,
        sort_order: index,
      })),
    );


    // Status changes never travel with a plain update — route them through the
    // state machine so illegal transitions are rejected server-side.
    if (nextStatus) {
      const current = estimates.find((e) => e.id === id)?.status;
      if (nextStatus !== current) {
        await setEstimateStatus(id, nextStatus as EstimateStatus);
      }
    }


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

    if ((estimate as any).converted_sales_order_id) {
      throw new Error(`Estimate ${estimate.estimate_number} has already been converted to a sales order.`);
    }
    if ((estimate as any).converted_invoice_id) {
      throw new Error(`Estimate ${estimate.estimate_number} has already been converted to an invoice.`);
    }

    const convertibleStatuses = ["draft", "sent", "viewed", "accepted"];
    if (!convertibleStatuses.includes(estimate.status)) {
      throw new Error(`Cannot convert estimate with status "${estimate.status}".`);
    }

    if (!user) throw new Error("Not authenticated");

    // Sales audit Phase B (finding #5 + #6): use atomic RPC. The DB function
    // sets source_estimate_id on the invoice, copies items verbatim with the
    // canonical tax-exclusive line_total convention, and flips the estimate
    // to 'converted' in a single transaction so we cannot get an invoice
    // without the estimate being marked converted.
    // It also posts and issues the invoice ('sent') in the same transaction —
    // a converted estimate is a customer commitment, not a draft. If posting
    // is impossible (missing default accounts, closed period) the invoice is
    // still created as a draft and `confirm_error` explains why.
    const { data, error } = await supabase.rpc("convert_estimate_to_invoice_atomic" as any, {
      p_estimate_id: estimateId,
      p_user_id: user.id,
      p_auto_confirm: true,
    });
    if (error) throw error;
    const result = data as {
      success: boolean;
      invoice_id: string;
      invoice_number: string;
      invoice_status?: string;
      confirmed?: boolean;
      confirm_error?: string | null;
    };
    if (!result?.success) throw new Error("Estimate conversion failed");

    invalidate();
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
    return {
      id: result.invoice_id,
      invoice_number: result.invoice_number,
      status: result.invoice_status ?? "draft",
      confirmed: result.confirmed ?? false,
      confirmError: result.confirm_error ?? null,
    };

  };

  const convertToSalesOrder = async (estimateId: string) => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    const estimate = estimates.find((e) => e.id === estimateId);
    if (!estimate) throw new Error("Estimate not found");
    if ((estimate as any).converted_sales_order_id || (estimate as any).converted_invoice_id) {
      throw new Error(`Estimate ${estimate.estimate_number} has already been converted.`);
    }

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
    setEstimateStatus,
    deleteEstimate,
    convertToInvoice,
    convertToSalesOrder,
    refreshEstimates: invalidate,
  };
}
