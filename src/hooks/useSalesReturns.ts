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

  const getNextNumber = async () => {
    if (!currentOrg) return "";
    const { data, error } = await supabase.rpc("get_next_sales_return_number", { _org_id: currentOrg.id });
    if (error) throw error;
    return data;
  };

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
      const returnNumber = await getNextNumber();
      const { data: { user } } = await supabase.auth.getUser();

      // Phase 1/4: stamp branch_id on insert so returns are branch-attributed.
      // The DB trigger `cascade_branch_from_invoice_to_return` will overwrite this
      // with the linked invoice's branch when invoice_id is set.
      const { data: newReturn, error: returnError } = await supabase
        .from("sales_returns")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          branch_id: currentBranch?.id ?? null,
          return_number: returnNumber,
          contact_id: returnData.contact_id,
          return_date: returnData.return_date || new Date().toISOString().split('T')[0],
          status: returnData.status || 'pending',
          invoice_id: returnData.invoice_id,
          reason: returnData.reason,
          currency: returnData.currency || currentBusiness.base_currency,
          subtotal: returnData.subtotal || 0,
          tax_amount: returnData.tax_amount || 0,
          total: returnData.total || 0,
          refund_method: returnData.refund_method,
          notes: returnData.notes,
          created_by: user?.id,
        })
        .select()
        .single();

      if (returnError) throw returnError;

      if (items.length > 0) {
        const returnItems = items.map((item, index) => ({
          sales_return_id: newReturn.id,
          description: item.description,
          unit_price: item.unit_price,
          line_total: item.line_total,
          quantity: item.quantity || 1,
          product_id: item.product_id,
          invoice_item_id: item.invoice_item_id,
          tax_rate: item.tax_rate,
          tax_amount: item.tax_amount,
          return_reason: item.return_reason,
          condition: item.condition,
          sort_order: index,
        }));
        const { error: itemsError } = await supabase.from("sales_return_items").insert(returnItems);
        if (itemsError) throw itemsError;
      }

      toast.success("Sales return created successfully");
      logAction({ action: "created", entityType: "sales_return" as any, entityId: newReturn.id, entityName: returnNumber, changesSummary: `Sales return created: ${returnNumber}` });
      invalidate();
      return newReturn;
    } catch (error) {
      console.error("Error creating sales return:", error);
      toast.error("Failed to create sales return");
      return null;
    }
  };

  const updateSalesReturn = async (id: string, updates: Partial<SalesReturn>) => {
    try {
      const { contact, credit_note, invoice, items, ...dbUpdates } = updates as any;
      const { error } = await supabase.from("sales_returns").update(dbUpdates).eq("id", id);
      if (error) throw error;
      toast.success("Sales return updated successfully");
      invalidate();
    } catch (error) {
      console.error("Error updating sales return:", error);
      toast.error("Failed to update sales return");
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
      const { error } = await supabase.from("sales_returns").update({ status: "rejected" }).eq("id", id);
      if (error) throw error;
      toast.success("Return rejected");
      invalidate();
    } catch (error) {
      console.error("Error rejecting return:", error);
      toast.error("Failed to reject return");
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
