import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { queryKeys } from "@/lib/queryKeys";
import { toast } from "sonner";
import { useAuditLog } from "./useAuditLog";
import { useBranch } from "@/contexts/BranchContext";
import { applyBranchFilter } from "@/lib/branchScope";

export interface SalesReturn {
  id: string;
  organization_id: string;
  contact_id: string | null;
  return_number: string;
  return_date: string;
  status: string;
  invoice_id: string | null;
  reason: string;
  currency: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  refund_method: string | null;
  credit_note_id: string | null;
  notes: string | null;
  /** Phase 5 provenance — set when the return was raised by a warehouse RMA. */
  wms_return_order_id?: string | null;
  wms_return_order?: { id: string; code: string | null; state: string | null } | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  contact?: { name: string; email: string | null } | null;
  invoice?: { invoice_number: string; total: number; amount_paid: number } | null;
  credit_note?: {
    id: string;
    credit_note_number: string;
    status: string;
    total: number;
    amount_applied: number;
    refund_amount: number | null;
  } | null;
  items?: SalesReturnItem[];
}

export interface SalesReturnItem {
  id: string;
  sales_return_id: string;
  product_id: string | null;
  invoice_item_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number | null;
  tax_amount: number | null;
  line_total: number;
  return_reason: string | null;
  condition: string | null;
  sort_order: number;
}

async function fetchSalesReturnsFn(orgId: string, businessId: string, branchId: string | null) {
  let query = supabase
    .from("sales_returns")
    .select(`
      *,
      contact:contacts(name, email),
      invoice:invoices(invoice_number, total, amount_paid),
      wms_return_order:wms_return_orders(id, code, state),
      credit_note:credit_notes!sales_returns_credit_note_id_fkey(id, credit_note_number, status, total, amount_applied, refund_amount)
    `)
    .eq("organization_id", orgId)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  query = applyBranchFilter(query, branchId);
  const { data, error } = await query;

  if (error) throw error;
  return (data || []) as SalesReturn[];
}

export function useSalesReturns() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { logAction } = useAuditLog();
  const queryClient = useQueryClient();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: salesReturns = [], isLoading } = useQuery({
    queryKey: [...queryKeys.salesReturns.list(orgId!, businessId), branchId],
    queryFn: () => fetchSalesReturnsFn(orgId!, businessId!, branchId),
    enabled: !!orgId && !!businessId,
  });

  const invalidate = useCallback(() => {
    if (!orgId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.salesReturns.all(orgId) });
  }, [queryClient, orgId]);

  const fetchReturnWithItems = async (returnId: string): Promise<SalesReturn | null> => {
    const { data, error } = await supabase
      .from("sales_returns")
      .select(`
        *,
        contact:contacts(name, email),
        invoice:invoices(invoice_number, total, amount_paid),
        credit_note:credit_notes!sales_returns_credit_note_id_fkey(id, credit_note_number, status, total, amount_applied, refund_amount),
        items:sales_return_items(*)
      `)
      .eq("id", returnId)
      .single();

    if (error) {
      console.error("Error fetching return details:", error);
      return null;
    }
    return data as SalesReturn;
  };

  const createSalesReturn = async (returnData: { reason: string } & Partial<SalesReturn>, items: Array<{
    description: string;
    unit_price: number;
    line_total: number;
    quantity?: number;
    product_id?: string | null;
    invoice_item_id?: string | null;
    tax_rate?: number | null;
    tax_amount?: number | null;
    return_reason?: string | null;
    condition?: string | null;
  }>) => {
    if (!currentOrg || !currentBusiness) return null;

    try {
      // Returns convergence Phase 3: header + lines + totals + number allocation
      // happen in one server transaction. Totals and the document number are
      // derived server-side; `client_request_id` makes a retry a no-op instead
      // of a duplicate return.
      const payload = {
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: currentBranch?.id ?? null,
        contact_id: returnData.contact_id ?? null,
        return_date: returnData.return_date || new Date().toISOString().split("T")[0],
        invoice_id: returnData.invoice_id ?? null,
        reason: returnData.reason,
        currency: returnData.currency || currentBusiness.base_currency,
        refund_method: returnData.refund_method ?? null,
        notes: returnData.notes ?? null,
        // Derived from the return intent (customer, invoice, date, line
        // fingerprint) — a random key would be fresh on every retry and would
        // defeat the server-side replay guard entirely.
        client_request_id: [
          "sret",
          currentBusiness.id,
          returnData.contact_id ?? "none",
          returnData.invoice_id ?? "none",
          returnData.return_date || new Date().toISOString().split("T")[0],
          items
            .map(
              (i) =>
                `${i.invoice_item_id ?? i.product_id ?? i.description}:${
                  Math.round((i.quantity ?? 1) * 1000)
                }:${Math.round((i.unit_price ?? 0) * 100)}`,
            )
            .sort()
            .join("|"),
        ].join("-"),
        items: items.map((item) => ({
          description: item.description,
          unit_price: item.unit_price,
          quantity: item.quantity ?? 1,
          product_id: item.product_id ?? null,
          invoice_item_id: item.invoice_item_id ?? null,
          tax_rate: item.tax_rate ?? 0,
          tax_amount: item.tax_amount ?? 0,
          return_reason: item.return_reason ?? null,
          condition: item.condition ?? "good",
          // Phase A.4 — persist picker output for lot/serial-tracked lines.
          lot_number: (item as any).lot_number ?? null,
          serial_number: (item as any).serial_number ?? null,
        })),
      };

      const { data, error } = await supabase.rpc("create_sales_return_atomic" as any, {
        _payload: payload as any,
      });
      if (error) throw error;
      const result = data as { success: boolean; id: string; return_number: string };
      if (!result?.success) throw new Error("Create sales return failed");

      toast.success(`Sales return ${result.return_number} created`);
      logAction({ action: "created", entityType: "sales_return" as any, entityId: result.id, entityName: result.return_number, changesSummary: `Sales return created: ${result.return_number}` });
      invalidate();
      return { id: result.id, return_number: result.return_number } as unknown as SalesReturn;
    } catch (error) {
      console.error("Error creating sales return:", error);
      toast.error((error as any)?.message || "Failed to create sales return");
      return null;
    }
  };

  const updateSalesReturn = async (id: string, updates: Partial<SalesReturn>) => {
    try {
      const { contact, credit_note, invoice, items, status, ...dbUpdates } = updates as any;
      if (status !== undefined) {
        // Lifecycle transitions belong to `transition_sales_return`, never to a
        // free-form client update.
        const { error: tErr } = await supabase.rpc("transition_sales_return" as any, {
          _return_id: id,
          _to_status: status,
          _reason: null,
        });
        if (tErr) throw tErr;
      }
      if (Object.keys(dbUpdates).length === 0) {
        toast.success("Sales return updated successfully");
        invalidate();
        return;
      }
      const { error } = await supabase.from("sales_returns").update(dbUpdates).eq("id", id);
      if (error) throw error;
      toast.success("Sales return updated successfully");
      invalidate();
    } catch (error) {
      console.error("Error updating sales return:", error);
      toast.error((error as any)?.message || "Failed to update sales return");
    }
  };

  const deleteSalesReturn = async (id: string) => {
    try {
      const sr = salesReturns.find((r) => r.id === id);
      if (sr?.credit_note_id) {
        toast.error("Cannot delete: this return has a linked Credit Note. Void the Credit Note first.");
        return;
      }
      if (sr && sr.status !== "pending") {
        toast.error("Cannot delete: only pending returns can be deleted.");
        return;
      }

      const { error } = await supabase.from("sales_returns").delete().eq("id", id);
      if (error) throw error;
      toast.success("Sales return deleted successfully");
      invalidate();
    } catch (error) {
      console.error("Error deleting sales return:", error);
      toast.error("Failed to delete sales return");
    }
  };

  const approveReturn = async (id: string) => {
    if (!currentOrg) return;

    try {
      // Sales audit Phase B (finding #9): wrap CN insert + items + stock + status
      // flip in one DB transaction via approve_sales_return_atomic. Previously
      // these were 4 separate client-side calls — partial failures left
      // half-approved returns.
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase.rpc("approve_sales_return_atomic" as any, {
        p_return_id: id,
        p_user_id: user.id,
      });
      if (error) throw error;
      const result = data as { success: boolean; credit_note_id: string; credit_note_number: string };
      if (!result?.success) throw new Error("Approve return failed");

      toast.success(`Return approved → Credit Note ${result.credit_note_number} created (draft). Inventory restocked.`);
      logAction({
        action: "approved",
        entityType: "sales_return" as any,
        entityId: id,
        entityName: result.credit_note_number,
        changesSummary: `Return approved, Credit Note ${result.credit_note_number} created`,
      });
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['credit-notes'] });
    } catch (error) {
      console.error("Error approving return:", error);
      toast.error((error as any)?.message || "Failed to approve return");
    }
  };

  const rejectReturn = async (id: string) => {
    try {
      const { error } = await supabase.rpc("transition_sales_return" as any, {
        _return_id: id,
        _to_status: "rejected",
        _reason: null,
      });
      if (error) throw error;
      toast.success("Return rejected");
      invalidate();
    } catch (error) {
      console.error("Error rejecting return:", error);
      toast.error((error as any)?.message || "Failed to reject return");
    }
  };

  return {
    salesReturns,
    isLoading,
    refresh: invalidate,
    createSalesReturn,
    updateSalesReturn,
    deleteSalesReturn,
    approveReturn,
    rejectReturn,
    fetchReturnWithItems,
  };
}
