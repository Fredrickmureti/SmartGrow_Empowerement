import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { queryKeys } from "@/lib/queryKeys";
import { applyBranchFilter } from "@/lib/branchScope";
import { useDefaultAccounts } from "./useDefaultAccounts";
import { useAuditLog } from "./useAuditLog";
import { confirmInvoiceAndPostGL } from "./invoices/confirmInvoiceGL";
import type { Invoice } from "./useInvoices";

export interface RecurringInvoiceItem {
  id?: string;
  recurring_invoice_id?: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  discount_percent: number;
  sort_order: number;
}

export interface RecurringInvoice {
  id: string;
  organization_id: string;
  contact_id: string | null;
  template_name: string;
  notes: string | null;
  terms: string | null;
  currency: string;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  start_date: string;
  end_date: string | null;
  next_run_date: string;
  last_run_date: string | null;
  is_active: boolean;
  auto_send: boolean;
  auto_confirm?: boolean;
  days_before_due: number;
  invoices_generated: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  contact?: { name: string; email: string | null } | null;
  items?: RecurringInvoiceItem[];
}

async function fetchRecurringFn(orgId: string, businessId?: string | null, branchId?: string | null) {
  let query = supabase
    .from("recurring_invoices")
    .select(`
      *,
      contact:contacts(name, email),
      items:recurring_invoice_items(*)
    `)
    .eq("organization_id", orgId);

  if (businessId) {
    query = query.eq("business_id", businessId);
  }
  // Sales audit Phase A: enforce branch isolation.
  query = applyBranchFilter(query, branchId ?? null);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return (data as unknown as RecurringInvoice[]) || [];
}

export function useRecurringInvoices() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { getInvoiceAccountMappings, hasRequiredAccounts, accounts: defaultAccountMappings } = useDefaultAccounts();
  const { logAction } = useAuditLog();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: recurringInvoices = [], isLoading } = useQuery({
    queryKey: [...queryKeys.recurringInvoices.list(orgId!, businessId), branchId],
    queryFn: () => fetchRecurringFn(orgId!, businessId, branchId),
    enabled: !!orgId,
  });

  const invalidate = useCallback(() => {
    if (!orgId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.recurringInvoices.all(orgId) });
  }, [queryClient, orgId]);

  const createRecurringInvoice = async (
    recurringInvoice: Omit<
      RecurringInvoice,
      "id" | "organization_id" | "created_at" | "updated_at" | "created_by" | "contact" | "items" | "invoices_generated" | "last_run_date"
    >,
    items: Omit<RecurringInvoiceItem, "id" | "recurring_invoice_id">[]
  ) => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    const { data: created, error: riError } = await supabase
      .from("recurring_invoices")
      .insert({
        ...recurringInvoice,
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        branch_id: currentBranch?.id ?? null,
        created_by: user.id,
      })
      .select()
      .single();

    if (riError) throw riError;

    if (items.length > 0) {
      const itemsToInsert = items.map((item, index) => ({
        ...item,
        recurring_invoice_id: created.id,
        sort_order: index,
      }));
      const { error: itemsError } = await supabase.from("recurring_invoice_items").insert(itemsToInsert);
      if (itemsError) throw itemsError;
    }

    invalidate();
    return created;
  };

  const updateRecurringInvoice = async (
    id: string,
    updates: Partial<RecurringInvoice>,
    items?: Omit<RecurringInvoiceItem, "id" | "recurring_invoice_id">[]
  ) => {
    if (items !== undefined) {
      await supabase.from("recurring_invoice_items").delete().eq("recurring_invoice_id", id);

      if (items.length > 0) {
        const itemsToInsert = items.map((item, index) => ({
          ...item,
          recurring_invoice_id: id,
          sort_order: index,
        }));
        const { error: itemsError } = await supabase.from("recurring_invoice_items").insert(itemsToInsert);
        if (itemsError) throw itemsError;
      }
    }

    const { contact, items: _i, ...dbUpdates } = updates as any;
    const { error } = await supabase.from("recurring_invoices").update(dbUpdates).eq("id", id);
    if (error) throw error;
    invalidate();
  };

  const deleteRecurringInvoice = async (id: string) => {
    const { error } = await supabase.from("recurring_invoices").delete().eq("id", id);
    if (error) throw error;
    invalidate();
  };

  const toggleActive = async (id: string, isActive: boolean) => {
    const { error } = await supabase.from("recurring_invoices").update({ is_active: isActive }).eq("id", id);
    if (error) throw error;
    invalidate();
  };

  const generateInvoiceNow = async (recurringInvoiceId: string) => {
    const ri = recurringInvoices.find((r) => r.id === recurringInvoiceId);
    if (!ri) throw new Error("Recurring invoice not found");

    const { data: invoiceNumber, error: numError } = await supabase.rpc(
      "get_next_invoice_number",
      { _org_id: currentOrg!.id, _business_id: ((ri as any).business_id ?? currentBusiness!.id) as string }
    );
    if (numError) throw numError;

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + ri.days_before_due);

    const items = ri.items || [];
    const subtotal = items.reduce(
      (sum, item) => sum + item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100),
      0
    );
    const taxAmount = items.reduce(
      (sum, item) => {
        const discountedAmount = item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100);
        return sum + discountedAmount * (item.tax_rate / 100);
      },
      0
    );
    const total = subtotal + taxAmount;

    // AUDIT FIX (G7): generated invoice MUST inherit the recurring template's
    // branch_id, NOT the caller's currently-active branch. The recurring rule
    // is the source of truth for where this revenue belongs.
    const templateBranchId = (ri as any).branch_id ?? null;
    const templateBusinessId = ((ri as any).business_id ?? currentBusiness?.id) as string | null;

    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .insert({
        organization_id: currentOrg!.id,
        business_id: templateBusinessId,
        branch_id: templateBranchId,
        contact_id: ri.contact_id,
        invoice_number: invoiceNumber,
        status: ri.auto_send ? "sent" : "draft",
        issue_date: new Date().toISOString().split("T")[0],
        due_date: dueDate.toISOString().split("T")[0],
        subtotal,
        tax_amount: taxAmount,
        total,
        currency: ri.currency,
        notes: ri.notes,
        terms: ri.terms,
        created_by: user!.id,
        source_recurring_id: recurringInvoiceId,
      } as any)
      .select()
      .single();

    if (invoiceError) throw invoiceError;

    if (items.length > 0) {
      const invoiceItems = items.map((item) => {
        const discountedLineTotal = item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100);
        return {
          invoice_id: invoice.id,
          product_id: item.product_id,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate,
          tax_amount: discountedLineTotal * (item.tax_rate / 100),
          discount_percent: item.discount_percent,
          line_total: discountedLineTotal,
          sort_order: item.sort_order,
        };
      });
      const { error: itemsError } = await supabase.from("invoice_items").insert(invoiceItems);
      if (itemsError) throw itemsError;
    }

    const nextRunDate = calculateNextRunDate(ri.frequency, new Date());

    await supabase
      .from("recurring_invoices")
      .update({
        last_run_date: new Date().toISOString().split("T")[0],
        next_run_date: nextRunDate,
        invoices_generated: ri.invoices_generated + 1,
      })
      .eq("id", recurringInvoiceId);

    // Sales audit Phase F: if the template opts into auto-confirm, post the
    // generated invoice to GL immediately via the shared confirm helper. This
    // builds real AR/Revenue/Tax JE lines and uses the canonical 3-arg RPC
    // (ADR 0026 — COGS posts only at goods-issue). Best-effort: failure leaves
    // the invoice as draft for manual confirmation. Only draft invoices are
    // eligible (auto_send promotes to 'sent', which is a separate flow).
    if ((ri as any).auto_confirm === true && invoice.status === "draft") {
      try {
        await confirmInvoiceAndPostGL(invoice as unknown as Invoice, {
          hasRequiredAccounts,
          getInvoiceAccountMappings,
          systemDefaults: defaultAccountMappings,
          logAction,
          userId: user!.id,
          releaseStock: true,
        });
      } catch (e) {
        console.warn("Auto-confirm failed for generated invoice; left as draft:", e);
      }
    }

    invalidate();
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
    return invoice;
  };

  return {
    recurringInvoices,
    activeRecurringInvoices: recurringInvoices.filter((ri) => ri.is_active),
    isLoading,
    createRecurringInvoice,
    updateRecurringInvoice,
    deleteRecurringInvoice,
    toggleActive,
    generateInvoiceNow,
    refreshRecurringInvoices: invalidate,
  };
}

function calculateNextRunDate(
  frequency: RecurringInvoice["frequency"],
  fromDate: Date
): string {
  const originalDay = fromDate.getDate();
  const date = new Date(fromDate);

  switch (frequency) {
    case "weekly":
      date.setDate(date.getDate() + 7);
      break;
    case "biweekly":
      date.setDate(date.getDate() + 14);
      break;
    case "monthly":
      date.setMonth(date.getMonth() + 1);
      if (date.getDate() < originalDay) date.setDate(0);
      break;
    case "quarterly":
      date.setMonth(date.getMonth() + 3);
      if (date.getDate() < originalDay) date.setDate(0);
      break;
    case "yearly":
      date.setFullYear(date.getFullYear() + 1);
      if (date.getDate() < originalDay) date.setDate(0);
      break;
  }

  return date.toISOString().split("T")[0];
}
