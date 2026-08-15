import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { useGLPosting } from "./useGLPosting";
import { useDefaultAccounts } from "./useDefaultAccounts";
import { usePermissions } from "./usePermissions";
import { confirmInvoiceAndPostGL } from "./invoices/confirmInvoiceGL";
import { triggerAutomation, getChangedFields } from "@/lib/automations/triggerAutomation";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";
import { captureBillToSnapshot } from "@/lib/contactAddresses";

export interface InvoiceItem {
  id?: string;
  invoice_id?: string;
  product_id?: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number;
  discount_percent: number;
  line_total: number;
  sort_order: number;
  /** Optional analytic tags — wins over header.project_id on the analytic posting trigger. */
  project_id?: string | null;
  task_id?: string | null;
}

export interface Invoice {
  id: string;
  organization_id: string;
  contact_id: string | null;
  invoice_number: string;
  status: "draft" | "confirmed" | "sent" | "viewed" | "partial" | "paid" | "overdue" | "cancelled" | "voided";
  issue_date: string;
  due_date: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  amount_paid: number;
  currency: string;
  notes: string | null;
  terms: string | null;
  created_by: string | null;
  salesperson_id: string | null;
  confirmed_by: string | null;
  created_at: string;
  updated_at: string;
  voided_by?: string | null;
  source?: string | null;
  contact?: { name: string; email: string | null; phone: string | null } | null;
  invoice_items?: InvoiceItem[];
}

export function useInvoices() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { can } = usePermissions();
  const { postToGL } = useGLPosting();
  const { getInvoiceAccountMappings, hasRequiredAccounts, accounts: defaultAccountMappings } = useDefaultAccounts();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchInvoices = async () => {
    if (!currentOrg || !currentBusiness) return;

    setIsLoading(true);
    try {
      let query = supabase
        .from("invoices")
        .select(`
          *,
          contact:contacts(name, email, phone)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false });
      // Sales audit Phase A: enforce branch isolation. Without this, branch users
      // see other branches' invoices (the most-used Sales table — biggest leak).
      query = applyBranchFilter(query, currentBranch?.id ?? null);
      const { data, error } = await query;

      if (error) throw error;
      setInvoices(data as Invoice[]);
    } catch (error: any) {
      console.error("Error fetching invoices:", error);
      toast({
        title: "Error loading invoices",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchInvoices();
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  const getNextInvoiceNumber = async (): Promise<string> => {
    if (!currentOrg || !currentBusiness) return "INV-0001";

    const { data, error } = await supabase.rpc("get_next_invoice_number", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
    });

    if (error) {
      console.error("Error getting invoice number:", error);
      return `INV-${Date.now()}`;
    }

    return data || "INV-0001";
  };

  /**
   * Create an invoice in DRAFT status.
   * No GL posting happens here — GL is only posted on confirmation.
   */
  const createInvoice = async (
    invoice: { contact_id?: string; due_date: string; notes?: string; terms?: string; discount_amount?: number; currency?: string; salesperson_id?: string; payment_term_id?: string | null; branch_id?: string | null },
    items: Omit<InvoiceItem, "id" | "invoice_id">[]
  ) => {
    if (!can("manageSales")) { toast({ title: "Permission denied", description: "You don't have permission to create invoices", variant: "destructive" }); throw new Error("Permission denied"); }
    if (!currentOrg || !currentBusiness || !user) throw new Error("No business selected");

    const invoiceNumber = await getNextInvoiceNumber();

    // Calculate totals.
    // Sales audit Phase B: line_total is tax-EXCLUSIVE (matches Odoo and the
    // estimates hook). Total = subtotal + tax - discount.
    let subtotal = 0;
    let taxAmount = 0;
    items.forEach((item) => {
      subtotal += item.line_total;
      taxAmount += item.tax_amount;
    });

    // Freeze the bill-to address on the document (Phase 5): the printed
    // address must not follow later edits to the customer's address book.
    const billTo = await captureBillToSnapshot(invoice.contact_id);

    const insertData = {
      contact_id: invoice.contact_id,
      ...billTo,
      due_date: invoice.due_date,
      notes: invoice.notes,
      terms: invoice.terms,
      discount_amount: invoice.discount_amount || 0,
      currency: invoice.currency || currentBusiness.base_currency,
      organization_id: currentOrg.id,
      business_id: currentBusiness.id,
      // Stage 3 (audit Phase D): stamp the active branch so per-branch P&L /
      // sales reports can attribute revenue. Caller may override; falls back
      // to the user's current branch (NULL = "Unassigned").
      branch_id: invoice.branch_id ?? currentBranch?.id ?? null,
      invoice_number: invoiceNumber,
      subtotal,
      tax_amount: taxAmount,
      total: subtotal + taxAmount - (invoice.discount_amount || 0),
      created_by: user.id,
      salesperson_id: invoice.salesperson_id || user.id,
      payment_term_id: invoice.payment_term_id || null,
    };

    const { data: newInvoice, error: invoiceError } = await supabase
      .from("invoices")
      .insert(insertData)
      .select()
      .single();

    if (invoiceError) throw invoiceError;

    // Insert line items
    const lineItemsToInsert = items.map((item, index) => ({
      invoice_id: newInvoice.id,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      discount_percent: item.discount_percent,
      line_total: item.line_total,
      sort_order: index,
      product_id: item.product_id,
      project_id: item.project_id ?? null,
      task_id: item.task_id ?? null,
      // Phase A.4 — persist picker output for lot/serial-tracked lines.
      lot_number: (item as any).lot_number ?? null,
      serial_number: (item as any).serial_number ?? null,
    }));

    if (items.length > 0) {
      const { error: itemsError } = await supabase
        .from("invoice_items")
        .insert(lineItemsToInsert);

      if (itemsError) throw itemsError;
    }

    // Log audit action
    logAction({
      action: "created",
      entityType: "invoice",
      entityId: newInvoice.id,
      entityName: invoiceNumber,
      changesSummary: `Created invoice ${invoiceNumber} for ${insertData.total}`,
    });

    // NOTE: GL posting is NOT done here. It happens in confirmInvoice().

    // Optimistic update - add to local state immediately
    setInvoices((prev) => [{ ...newInvoice, invoice_items: lineItemsToInsert } as Invoice, ...prev]);

    // Trigger automations (fire-and-forget)
    triggerAutomation({
      event_type: "on_create",
      target_model: "invoice",
      record_id: newInvoice.id,
      record_data: newInvoice,
      organization_id: currentOrg.id,
    });
    
    return newInvoice;
  };

  /**
   * Confirm an invoice and post to the General Ledger.
   * This transitions the invoice from "draft" to "confirmed" and creates journal entries.
   * Per Odoo/QuickBooks standards, only confirmed invoices affect the GL.
   */
  const confirmInvoice = async (id: string) => {
    if (!can("manageSales")) { toast({ title: "Permission denied", description: "You don't have permission to confirm invoices", variant: "destructive" }); throw new Error("Permission denied"); }

    const invoice = invoices.find((i) => i.id === id);
    if (!invoice) throw new Error("Invoice not found");

    // Optimistic update
    setInvoices((prev) =>
      prev.map((i) => (i.id === id ? { ...i, status: "confirmed" as const } : i))
    );

    try {
      await confirmInvoiceAndPostGL(invoice, {
        postToGL,
        hasRequiredAccounts,
        getInvoiceAccountMappings,
        systemDefaults: defaultAccountMappings,
        logAction,
        userId: user?.id,
        releaseStock: true,
      });
      toast({ title: "Invoice confirmed", description: `${invoice.invoice_number} has been posted and stockable items were released through delivery.` });
    } catch (error) {
      setInvoices((prev) =>
        prev.map((i) => (i.id === id ? { ...i, status: "draft" as const } : i))
      );
      throw error;
    }
  };

  const updateInvoiceStatus = async (
    id: string,
    status: Invoice["status"]
  ) => {
    if (!can("manageSales")) { toast({ title: "Permission denied", description: "You don't have permission to update invoices", variant: "destructive" }); throw new Error("Permission denied"); }
    const invoice = invoices.find((i) => i.id === id);
    if (!invoice) throw new Error("Invoice not found");
    const oldStatus = invoice.status;

    // AUDIT FIX (G1): Odoo separates "Validate" (post GL) from "Send" (status
    // flip). Auto-confirming inside a status update created a partial state if
    // the follow-up status write failed: the JE was posted but rollback only
    // restored the in-memory status. We now REFUSE to flip a draft to a post-
    // confirmation status without an explicit confirm step. UI must call
    // `confirmInvoice()` first (or use a "Confirm & Send" composite action).
    const requiresConfirmation = oldStatus === "draft" && ["sent", "viewed", "partial", "paid", "overdue"].includes(status);
    if (requiresConfirmation) {
      throw new Error(
        `Invoice ${invoice.invoice_number} must be confirmed first. Use 'Confirm' before changing status.`
      );
    }

    // Sales audit Phase B (finding #7): status changes after confirmation MUST
    // NEVER touch GL. Only confirmInvoice (draft→confirmed) and voidInvoice
    // post or reverse journal entries.

    // Optimistic update
    setInvoices((prev) =>
      prev.map((i) => (i.id === id ? { ...i, status } : i))
    );

    try {
      // Phase 6.3: `invoices.status` is a governed column. The trigger
      // `trg_00_invoices_governed_write` rejects a direct table update, so the
      // transition goes through the sanctioned engine, which re-checks the
      // legal transition table server-side (a client `if` is not a control).
      const { error } = await supabase.rpc("set_invoice_status_atomic" as never, {
        p_invoice_id: id,
        p_status: status,
      } as never);

      if (error) throw error;

      // Log status change
      logAction({
        action: status === "paid" ? "paid" : status === "partial" ? "partial_paid" : "updated",
        entityType: "invoice",
        entityId: id,
        entityName: invoice.invoice_number,
        oldValues: { status: oldStatus },
        newValues: { status },
        changesSummary: `Status changed from ${oldStatus} to ${status}`,
      });

      // Trigger automations on status change (fire-and-forget)
      if (currentOrg) {
        triggerAutomation({
          event_type: "field_change",
          target_model: "invoice",
          record_id: id,
          record_data: { ...invoice, status },
          old_data: invoice as unknown as Record<string, unknown>,
          changed_fields: ["status"],
          organization_id: currentOrg.id,
        });
      }
    } catch (error) {
      // Rollback on error
      setInvoices((prev) =>
        prev.map((i) => (i.id === id ? { ...i, status: oldStatus as Invoice["status"] } : i))
      );
      throw error;
    }
  };

  const deleteInvoice = async (id: string) => {
    if (!can("manageSales")) { toast({ title: "Permission denied", description: "You don't have permission to delete invoices", variant: "destructive" }); throw new Error("Permission denied"); }
    const invoice = invoices.find((i) => i.id === id);

    // Prevent deletion of confirmed/posted invoices - they must be voided instead
    if (invoice && invoice.status !== "draft") {
      toast({
        title: "Cannot delete",
        description: "Only draft invoices can be deleted. Use void/cancel for confirmed invoices.",
        variant: "destructive",
      });
      throw new Error("Only draft invoices can be deleted");
    }
    
    // Optimistic update
    setInvoices((prev) => prev.filter((i) => i.id !== id));

    try {
      const { error } = await supabase.from("invoices").delete().eq("id", id);
      if (error) throw error;

      // Log deletion
      if (invoice) {
        logAction({
          action: "deleted",
          entityType: "invoice",
          entityId: id,
          entityName: invoice.invoice_number,
          changesSummary: `Deleted invoice ${invoice.invoice_number}`,
        });
      }
    } catch (error) {
      // Rollback on error
      if (invoice) {
        setInvoices((prev) => [...prev, invoice]);
      }
      throw error;
    }
  };

  return {
    invoices,
    isLoading,
    createInvoice,
    confirmInvoice,
    updateInvoiceStatus,
    deleteInvoice,
    getNextInvoiceNumber,
    refreshInvoices: fetchInvoices,
  };
}
