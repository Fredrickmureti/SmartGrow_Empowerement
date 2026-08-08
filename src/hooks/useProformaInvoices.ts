import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePermissions } from "./usePermissions";
import { useAuditLog } from "./useAuditLog";
import { queryKeys } from "@/lib/queryKeys";
import { toast } from "sonner";
import { applyBranchFilter } from "@/lib/branchScope";


export interface ProformaInvoice {
  id: string;
  organization_id: string;
  contact_id: string | null;
  proforma_number: string;
  issue_date: string;
  expiry_date: string;
  status: string;
  currency: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  notes: string | null;
  terms: string | null;
  converted_invoice_id: string | null;
  converted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  contact?: { name: string; email: string | null } | null;
  items?: ProformaInvoiceItem[];
}

export interface ProformaInvoiceItem {
  id: string;
  proforma_invoice_id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number | null;
  tax_amount: number | null;
  discount_percent: number | null;
  line_total: number;
  sort_order: number;
}

async function fetchProformasFn(orgId: string, businessId?: string | null, branchId?: string | null) {
  let query = supabase
    .from("proforma_invoices")
    .select(`*, contact:contacts(name, email)`)
    .eq("organization_id", orgId);

  if (businessId) {
    query = query.eq("business_id", businessId);
  }
  // Sales audit Phase A: enforce branch isolation.
  query = applyBranchFilter(query, branchId ?? null);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []) as ProformaInvoice[];
}

export function useProformaInvoices() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const queryClient = useQueryClient();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: proformaInvoices = [], isLoading } = useQuery({
    queryKey: [...queryKeys.proformaInvoices.list(orgId!, businessId), branchId],
    queryFn: () => fetchProformasFn(orgId!, businessId, branchId),
    enabled: !!orgId,
  });

  const invalidate = useCallback(() => {
    if (!orgId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.proformaInvoices.all(orgId) });
  }, [queryClient, orgId]);

  const getNextNumber = async () => {
    if (!currentOrg) return "";
    const { data, error } = await supabase.rpc("get_next_proforma_number", { _org_id: currentOrg.id });
    if (error) throw error;
    return data;
  };

  const createProformaInvoice = async (invoice: { expiry_date: string } & Partial<ProformaInvoice>, items: Array<{
    description: string;
    unit_price: number;
    line_total: number;
    quantity?: number;
    product_id?: string | null;
    tax_rate?: number | null;
    tax_amount?: number | null;
    discount_percent?: number | null;
  }>) => {
    if (!currentOrg) return null;

    try {
      const proformaNumber = await getNextNumber();
      const { data: { user } } = await supabase.auth.getUser();

      const { data: newInvoice, error: invoiceError } = await supabase
        .from("proforma_invoices")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id || null,
          branch_id: currentBranch?.id ?? null,
          proforma_number: proformaNumber,
          contact_id: invoice.contact_id,
          issue_date: invoice.issue_date || new Date().toISOString().split('T')[0],
          expiry_date: invoice.expiry_date,
          status: invoice.status || 'draft',
          currency: invoice.currency || currentBusiness?.base_currency,
          subtotal: invoice.subtotal || 0,
          tax_amount: invoice.tax_amount || 0,
          discount_amount: invoice.discount_amount || 0,
          total: invoice.total || 0,
          notes: invoice.notes,
          terms: invoice.terms,
          created_by: user?.id,
        })
        .select()
        .single();

      if (invoiceError) throw invoiceError;

      if (items.length > 0) {
        const invoiceItems = items.map((item, index) => ({
          proforma_invoice_id: newInvoice.id,
          description: item.description,
          unit_price: item.unit_price,
          line_total: item.line_total,
          quantity: item.quantity || 1,
          product_id: item.product_id,
          tax_rate: item.tax_rate,
          tax_amount: item.tax_amount,
          discount_percent: item.discount_percent,
          sort_order: index,
        }));

        const { error: itemsError } = await supabase.from("proforma_invoice_items").insert(invoiceItems);
        if (itemsError) throw itemsError;
      }

      toast.success("Proforma invoice created successfully");
      invalidate();
      return newInvoice;
    } catch (error) {
      console.error("Error creating proforma invoice:", error);
      toast.error("Failed to create proforma invoice");
      return null;
    }
  };

  const updateProformaInvoice = async (id: string, updates: Partial<ProformaInvoice>) => {
    try {
      const { contact, items, ...dbUpdates } = updates as any;
      const { error } = await supabase.from("proforma_invoices").update(dbUpdates).eq("id", id);
      if (error) throw error;
      toast.success("Proforma invoice updated successfully");
      invalidate();
    } catch (error) {
      console.error("Error updating proforma invoice:", error);
      toast.error("Failed to update proforma invoice");
    }
  };

  const deleteProformaInvoice = async (id: string) => {
    try {
      const { error } = await supabase.from("proforma_invoices").delete().eq("id", id);
      if (error) throw error;
      toast.success("Proforma invoice deleted successfully");
      invalidate();
    } catch (error) {
      console.error("Error deleting proforma invoice:", error);
      toast.error("Failed to delete proforma invoice");
    }
  };

  const convertToInvoice = async (proformaId: string) => {
    if (!currentOrg) return null;

    try {
      // Sales audit Phase F: atomic RPC. Single DB transaction creates the
      // invoice header + items and flips the proforma to 'converted'. Replaces
      // the previous 3-step client orchestration that could leave an orphan
      // invoice if the proforma update failed.
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase.rpc("convert_proforma_to_invoice_atomic" as any, {
        p_proforma_id: proformaId,
        p_user_id: user.id,
      });
      if (error) throw error;
      const result = data as { success: boolean; invoice_id: string; invoice_number: string };
      if (!result?.success) throw new Error("Proforma conversion failed");

      toast.success(`Converted to invoice ${result.invoice_number}`);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      return { id: result.invoice_id, invoice_number: result.invoice_number };
    } catch (error) {
      console.error("Error converting proforma to invoice:", error);
      toast.error((error as any)?.message || "Failed to convert proforma invoice");
      return null;
    }
  };

  return {
    proformaInvoices,
    isLoading,
    refresh: invalidate,
    createProformaInvoice,
    updateProformaInvoice,
    deleteProformaInvoice,
    convertToInvoice,
  };
}
