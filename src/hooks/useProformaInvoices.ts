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
  const { can } = usePermissions();
  const { logAction } = useAuditLog();
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

  const requireManage = (verb: string) => {
    if (!can("manageSales")) {
      toast.error(`You don't have permission to ${verb} proforma invoices`);
      return false;
    }
    return true;
  };

  const getNextNumber = async () => {
    if (!currentOrg || !currentBusiness) return "";
    const { data, error } = await supabase.rpc("get_next_proforma_number", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
    });
    if (error) throw error;
    return data;
  };

  // Proforma convergence: creation is a single atomic RPC. The server allocates
  // the number under an advisory lock, inserts header + lines in one
  // transaction and recomputes subtotal/tax/total from the lines.
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
    if (!currentBusiness) {
      toast.error("Select a company before creating a proforma invoice");
      return null;
    }
    if (!requireManage("create")) return null;

    try {
      const { data, error } = await supabase.rpc("create_proforma_atomic" as any, {
        p_header: {
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          branch_id: currentBranch?.id ?? null,
          contact_id: invoice.contact_id ?? null,
          issue_date: invoice.issue_date || new Date().toISOString().split("T")[0],
          expiry_date: invoice.expiry_date,
          currency: invoice.currency || currentBusiness.base_currency,
          notes: invoice.notes ?? null,
          terms: invoice.terms ?? null,
        },
        p_items: items.map((item) => ({
          product_id: item.product_id ?? null,
          description: item.description,
          quantity: item.quantity ?? 1,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate ?? 0,
          discount_percent: item.discount_percent ?? 0,
        })),
      });
      if (error) throw error;
      const result = data as { success: boolean; id: string; proforma_number: string; total: number };
      if (!result?.success) throw new Error("Proforma creation failed");

      logAction({
        action: "create",
        entityType: "proforma_invoice",
        entityId: result.id,
        entityName: result.proforma_number,
        newValues: { total: result.total, status: "draft" },
      });

      toast.success(`Proforma invoice ${result.proforma_number} created`);
      invalidate();
      return { id: result.id, proforma_number: result.proforma_number };
    } catch (error) {
      console.error("Error creating proforma invoice:", error);
      toast.error((error as any)?.message || "Failed to create proforma invoice");
      return null;
    }
  };

  const updateProformaInvoice = async (id: string, updates: Partial<ProformaInvoice>) => {
    if (!requireManage("update")) return;
    try {
      // Status is owned by the lifecycle state machine — never write it directly.
      const { contact, items, status, ...dbUpdates } = updates as any;
      const { error } = await supabase.from("proforma_invoices").update(dbUpdates).eq("id", id);
      if (error) throw error;
      logAction({ action: "update", entityType: "proforma_invoice", entityId: id, newValues: dbUpdates });
      toast.success("Proforma invoice updated successfully");
      invalidate();
    } catch (error) {
      console.error("Error updating proforma invoice:", error);
      toast.error((error as any)?.message || "Failed to update proforma invoice");
    }
  };

  const setProformaStatus = async (id: string, status: string, reason?: string) => {
    if (!requireManage("update")) return false;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase.rpc("set_proforma_status_atomic" as any, {
        p_proforma_id: id,
        p_status: status,
        p_user_id: user?.id ?? null,
        p_reason: reason ?? null,
      });
      if (error) throw error;
      const result = data as { success: boolean; status: string; from_status?: string };
      logAction({
        action: "status_change",
        entityType: "proforma_invoice",
        entityId: id,
        oldValues: { status: result?.from_status },
        newValues: { status },
      });
      toast.success(`Proforma marked as ${status}`);
      invalidate();
      return true;
    } catch (error) {
      console.error("Error changing proforma status:", error);
      toast.error((error as any)?.message || "Failed to change proforma status");
      return false;
    }
  };

  const deleteProformaInvoice = async (id: string) => {
    if (!requireManage("delete")) return;
    try {
      const { error } = await supabase.from("proforma_invoices").delete().eq("id", id);
      if (error) throw error;
      logAction({ action: "delete", entityType: "proforma_invoice", entityId: id });
      toast.success("Proforma invoice deleted successfully");
      invalidate();
    } catch (error) {
      console.error("Error deleting proforma invoice:", error);
      toast.error((error as any)?.message || "Failed to delete proforma invoice");
    }
  };

  const convertToInvoice = async (proformaId: string) => {
    if (!currentOrg) return null;
    if (!requireManage("convert")) return null;

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

      logAction({
        action: "convert",
        entityType: "proforma_invoice",
        entityId: proformaId,
        newValues: { invoice_id: result.invoice_id, invoice_number: result.invoice_number },
        changesSummary: `Converted to invoice ${result.invoice_number}`,
      });

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
    getNextNumber,
    createProformaInvoice,
    updateProformaInvoice,
    setProformaStatus,
    deleteProformaInvoice,
    convertToInvoice,
  };
}

