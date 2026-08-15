import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { useGLPosting } from "./useGLPosting";
import { useDefaultAccounts } from "./useDefaultAccounts";
import { usePaginatedQuery } from "./usePaginatedQuery";
import { confirmInvoiceAndPostGL } from "./invoices/confirmInvoiceGL";
import { applyBranchFilter } from "@/lib/branchScope";
import { computeTotals, round2 } from "@/lib/invoiceLineMath";
import type { Invoice, InvoiceItem } from "./useInvoices";

export type { Invoice, InvoiceItem };

export interface InvoiceFilters {
  search?: string;
  status?: string;
  source?: "pos" | string;
  salespersonId?: string;
  /** Canonical aging bucket key: "not_due" | "current" | "days30" | "days60" | "days90" */
  aging?: string;
  /** Invoice-date lower bound (ISO yyyy-mm-dd, inclusive). */
  dateFrom?: string;
  /** Invoice-date upper bound (ISO yyyy-mm-dd, inclusive). */
  dateTo?: string;
}

export function useInvoicesPaginated(filters?: InvoiceFilters) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { postToGL } = useGLPosting();
  const { getInvoiceAccountMappings, hasRequiredAccounts, accounts: defaultAccountMappings } = useDefaultAccounts();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const {
    data: invoices,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    nextPage,
    previousPage,
    refetch,
  } = usePaginatedQuery<Invoice>({
    queryKey: ["invoices-paginated", organizationId, businessId, branchId, filters],
    queryFn: async ({ from, to }) => {
      if (!organizationId || !businessId) return { data: [], count: 0 };

      // If searching, first find matching contact IDs so we can search by customer name
      let matchingContactIds: string[] | null = null;
      if (filters?.search) {
        const { data: matchingContacts } = await supabase
          .from("contacts")
          .select("id")
          .eq("organization_id", organizationId)
          .eq("business_id", businessId)
          .ilike("name", `%${filters.search}%`)
          .limit(100);
        matchingContactIds = matchingContacts?.map(c => c.id) || [];
      }

      let query = supabase
        .from("invoices")
        .select(
          `
          *,
          contact:contacts(name, email, phone)
        `,
          { count: "exact" }
        )
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });

      // Branch isolation: when a branch is active, restrict to that branch
      // (plus legacy NULL-branch rows). HQ context (no branch) sees all.
      query = applyBranchFilter(query, branchId);

      // Apply filters
      if (filters?.status === "open") {
        // "Open" = all outstanding invoices
        query = query.in("status", ["sent", "viewed", "partial", "overdue", "confirmed"]);
      } else if (filters?.status && filters.status !== "all") {
        query = query.eq("status", filters.status as "draft" | "sent" | "viewed" | "partial" | "paid" | "overdue" | "cancelled" | "confirmed");
      }

      // Aging filter: restrict to outstanding invoices with due_date in bucket.
      // Bucket boundaries mirror public.finance_aging_bucket() exactly:
      //   not_due  due_date >  today
      //   current  today-30  <= due_date <= today      (0-30 days past due)
      //   days30   today-60  <= due_date <= today-31
      //   days60   today-90  <= due_date <= today-61
      //   days90   due_date  <  today-90
      if (filters?.aging) {
        // All aging filters only apply to open invoices
        if (!filters?.status) {
          query = query.in("status", ["sent", "viewed", "partial", "overdue", "confirmed"]);
        }
        const now = new Date();
        const dayOffset = (days: number) => {
          const d = new Date(now);
          d.setDate(d.getDate() - days);
          return d.toISOString().split("T")[0];
        };
        const today = dayOffset(0);
        if (filters.aging === "not_due") {
          query = query.gt("due_date", today);
        } else if (filters.aging === "current") {
          query = query.lte("due_date", today).gte("due_date", dayOffset(30));
        } else if (filters.aging === "days30") {
          query = query.lte("due_date", dayOffset(31)).gte("due_date", dayOffset(60));
        } else if (filters.aging === "days60") {
          query = query.lte("due_date", dayOffset(61)).gte("due_date", dayOffset(90));
        } else if (filters.aging === "days90") {
          query = query.lt("due_date", dayOffset(90));
        }
      }


      if (filters?.source === "pos") {
        query = query.eq("source", "pos");
      }

      if (filters?.search) {
        // Search by invoice number OR matching customer contact IDs
        if (matchingContactIds && matchingContactIds.length > 0) {
          query = query.or(`invoice_number.ilike.%${filters.search}%,contact_id.in.(${matchingContactIds.join(",")})`);
        } else {
          query = query.ilike("invoice_number", `%${filters.search}%`);
        }
      }

      if (filters?.salespersonId) {
        query = query.eq("salesperson_id", filters.salespersonId);
      }

      // Period filter (KPI deep-link: ?period=current_month etc maps to a
      // [dateFrom, dateTo] range on invoice_date).
      if (filters?.dateFrom) query = query.gte("invoice_date", filters.dateFrom);
      if (filters?.dateTo) query = query.lte("invoice_date", filters.dateTo);

      // Apply pagination range
      query = query.range(from, to);

      const { data, error, count } = await query;

      if (error) throw error;

      return {
        data: (data as Invoice[]) || [],
        count: count || 0,
      };
    },
    enabled: !!organizationId && !!businessId,
    pageSize: 50,
  });

  // Get aggregate stats (separate query for stats only)
  const [stats, setStats] = useState({
    total: 0,
    outstanding: 0,
    overdue: 0,
    paid: 0,
  });

  const fetchStats = useCallback(async () => {
    if (!organizationId || !businessId) return;

    let statsQuery = supabase
      .from("invoices")
      .select("status, total, amount_paid")
      .eq("organization_id", organizationId)
      .eq("business_id", businessId);
    statsQuery = applyBranchFilter(statsQuery, branchId);
    const { data, error } = await statsQuery;

    if (error) {
      console.error("Error fetching invoice stats:", error);
      return;
    }

    const calculated = {
      total: data.length,
      outstanding: data
        .filter((i) => ["sent", "viewed", "partial", "overdue", "confirmed"].includes(i.status))
        .reduce((sum, i) => sum + (i.total - i.amount_paid), 0),
      overdue: data
        .filter((i) => i.status === "overdue")
        .reduce((sum, i) => sum + (i.total - i.amount_paid), 0),
      paid: data
        .filter((i) => i.status === "paid")
        .reduce((sum, i) => sum + i.total, 0),
    };

    setStats(calculated);
  }, [organizationId, businessId, branchId]);

  // Fetch stats on mount and when org/business changes
  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

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

  const createInvoice = async (
    invoice: {
      contact_id?: string;
      due_date: string;
      notes?: string;
      terms?: string;
      discount_amount?: number;
      currency?: string;
      status?: "draft" | "sent";
      salesperson_id?: string;
      project_id?: string | null;
    },
    items: Omit<InvoiceItem, "id" | "invoice_id">[]
  ) => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    const invoiceNumber = await getNextInvoiceNumber();

    // Calculate totals.
    // CONTRACT: invoice_items.line_total is tax-EXCLUSIVE (= qty * price * (1 - disc%)),
    // tax_amount is per-line tax. Header subtotal = SUM(line_total) directly.
    // See src/lib/invoiceLineMath.ts and confirm_invoice_atomic validator.
    const { subtotal, tax_total: taxAmount, total } = computeTotals(
      items,
      invoice.discount_amount || 0,
    );

    const insertData = {
      contact_id: invoice.contact_id,
      due_date: invoice.due_date,
      notes: invoice.notes,
      terms: invoice.terms,
      discount_amount: round2(invoice.discount_amount || 0),
      currency: invoice.currency || currentBusiness?.base_currency,
      organization_id: currentOrg.id,
      business_id: currentBusiness?.id || null,
      // Stage 3: stamp the active branch for per-branch sales reporting.
      branch_id: (invoice as any).branch_id ?? currentBranch?.id ?? null,
      invoice_number: invoiceNumber,
      subtotal,
      tax_amount: taxAmount,
      total,
      created_by: user.id,
      salesperson_id: invoice.salesperson_id || user.id,
      status: invoice.status || "draft",
      project_id: invoice.project_id ?? null,
    };

    // Always insert as draft first, then confirm if needed
    const requestedStatus = insertData.status;
    const actualInsertData = { ...insertData, status: "draft" as const };

    const { data: newInvoice, error: invoiceError } = await supabase
      .from("invoices")
      .insert(actualInsertData)
      .select()
      .single();

    if (invoiceError) throw invoiceError;

    // Insert line items
    if (items.length > 0) {
      const lineItems = items.map((item, index) => ({
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
        // Phase B UoM provenance (DB trigger re-normalizes `quantity`)
        packaging_id: (item as any).packaging_id ?? null,
        display_uom_id: (item as any).display_uom_id ?? null,
        display_quantity: (item as any).display_quantity ?? null,
      }));

      const { error: itemsError } = await supabase
        .from("invoice_items")
        .insert(lineItems);

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

    // If "Mark as Sent" was requested, confirm + post to GL, then set to sent
    if (requestedStatus === "sent") {
      // Refetch so confirmInvoice can find the new invoice in the list
      await refetch();
      // Use updateInvoiceStatus which handles confirmation + GL posting
      await updateInvoiceStatus(newInvoice.id, "sent");
    }

    refetch();
    fetchStats();
    return newInvoice;
  };

  const updateInvoiceStatus = async (id: string, status: Invoice["status"]) => {
    // Look up in local state first, fall back to DB fetch
    let invoice = invoices.find((i) => i.id === id);
    if (!invoice) {
      const { data, error: fetchErr } = await supabase
        .from("invoices")
        .select("*, contact:contacts(name, email, phone)")
        .eq("id", id)
        .single();
      if (fetchErr || !data) throw new Error("Invoice not found");
      invoice = data as Invoice;
    }
    const oldStatus = invoice.status;

    // Normalize: "confirmed" is treated as "sent" (unified post-confirm status, matches Odoo/Xero/QB).
    // Any UI still calling with "confirmed" as the target will land on "sent" instead.
    const targetStatus = (status as string) === "confirmed" ? ("sent" as Invoice["status"]) : status;

    // Enforce workflow: draft invoices MUST go through confirmation (GL posting) before sent/paid
    const requiresConfirmation = oldStatus === "draft" && ["sent", "viewed", "partial", "paid", "overdue"].includes(targetStatus as string);
    if (requiresConfirmation) {
      // Auto-confirm first — this creates the journal entry (Dr AR / Cr Revenue) and sets status to "sent"
      await confirmInvoice(id);
      // confirmInvoice already lands on "sent". If that's the target, we're done.
      if (targetStatus === "sent") {
        refetch();
        fetchStats();
        return;
      }
      // Otherwise continue to update to the target status (e.g. "paid")
    }

    // Phase 6.3: governed column — the engine owns the transition table.
    const { error } = await supabase.rpc("set_invoice_status_atomic" as never, {
      p_invoice_id: id,
      p_status: targetStatus as string,
    } as never);

    if (error) throw error;

    // Log status change
    logAction({
      action:
        targetStatus === "paid"
          ? "paid"
          : targetStatus === "partial"
          ? "partial_paid"
          : "updated",
      entityType: "invoice",
      entityId: id,
      entityName: invoice.invoice_number,
      oldValues: { status: oldStatus },
      newValues: { status: targetStatus },
      changesSummary: `Status changed from ${oldStatus} to ${targetStatus}`,
    });

    refetch();
    fetchStats();
  };

  /**
   * Confirm an invoice and post to the General Ledger.
   * Transitions from "draft" to "sent" (unified status — matches "Mark as Sent" flow)
   * and creates the journal entry. This avoids the inconsistency where confirming
   * directly produced "confirmed" while creating-and-sending produced "sent".
   */
  const confirmInvoice = async (id: string) => {
    // Look up in local state first, fall back to DB fetch
    let invoice = invoices.find((i) => i.id === id);
    if (!invoice) {
      const { data, error: fetchErr } = await supabase
        .from("invoices")
        .select("*, contact:contacts(name, email, phone)")
        .eq("id", id)
        .single();
      if (fetchErr || !data) throw new Error("Invoice not found");
      invoice = data as Invoice;
    }

    await confirmInvoiceAndPostGL(invoice, {
      postToGL,
      hasRequiredAccounts,
      getInvoiceAccountMappings,
      systemDefaults: defaultAccountMappings,
      logAction,
      userId: user?.id,
      releaseStock: true,
    });

    // Single writer: `confirm_invoice_atomic` already lands the invoice on the
    // canonical post-confirm status ('sent'), so no client-side overwrite here.


    toast({ title: "Invoice confirmed", description: `${invoice.invoice_number} has been posted and stockable items were released through delivery.` });

    refetch();
    fetchStats();
  };

  const deleteInvoice = async (id: string) => {
    const invoice = invoices.find((i) => i.id === id);

    // Prevent deletion of confirmed/posted invoices
    if (invoice && invoice.status !== "draft") {
      toast({
        title: "Cannot delete",
        description: "Only draft invoices can be deleted. Use void/cancel for confirmed invoices.",
        variant: "destructive",
      });
      throw new Error("Only draft invoices can be deleted");
    }

    // Check for existing payment allocations before deleting.
    // Payments link to invoices via payment_allocations, not directly.
    const { data: existingAllocs } = await supabase
      .from("payment_allocations")
      .select("id")
      .eq("invoice_id", id)
      .limit(1);

    if (existingAllocs && existingAllocs.length > 0) {
      throw new Error("Cannot delete invoice with recorded payments. Void it instead.");
    }

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

    refetch();
    fetchStats();
  };

  return {
    invoices,
    isLoading,
    isFetching,
    stats,
    pagination,
    setPage,
    setPageSize,
    nextPage,
    previousPage,
    createInvoice,
    confirmInvoice,
    updateInvoiceStatus,
    deleteInvoice,
    getNextInvoiceNumber,
    refreshInvoices: refetch,
  };
}
