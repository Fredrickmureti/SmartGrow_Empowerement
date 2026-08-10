import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { useGLPosting } from "./useGLPosting";
import { useDefaultAccounts } from "./useDefaultAccounts";
import { usePaymentTerms } from "./usePaymentTerms";
import { usePermissions } from "./usePermissions";
import { resolveBillLineAccounts, groupByAccount, type ProductAccountInfo } from "@/lib/resolveProductAccounts";
import { confirmBillAndPostGL } from "./bills/confirmBillGL";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import { triggerAutomation } from "@/lib/automations/triggerAutomation";
import { assertCompanyScoped, assertBranchScoped } from "@/lib/purchases/scopingAssertions";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";
import { captureRemitToSnapshot } from "@/lib/contactAddresses";

export interface BillItem {
  id?: string;
  bill_id?: string;
  account_id: string | null;
  product_id: string | null;
  /**
   * Three-way match link: which PO line this bill line bills against.
   * Required when the bill is created from a PO; null for ad-hoc bills.
   * The DB trigger `sync_po_line_billed_quantities` blocks over-billing
   * (Σ quantity > quantity_received on the linked PO line).
   */
  purchase_order_item_id?: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number;
  line_total: number;
  sort_order: number;
  // UoM provenance — `quantity` stays in base units (DB trigger normalizes).
  packaging_id?: string | null;
  display_quantity?: number | null;
  display_uom_id?: string | null;
}

export interface Bill {
  id: string;
  organization_id: string;
  // Company + branch scope (NOT NULL on `bills.business_id` in the DB).
  // Surfacing these on the type drops several `as any` casts and lets the
  // compiler catch missing-scope inserts going forward.
  business_id: string;
  branch_id: string | null;
  vendor_id: string | null;
  account_id: string | null;
  bill_number: string;
  vendor_invoice_number: string | null;
  /**
   * Lifecycle (ADR: AP approval gate).
   *   draft → submitted → approved → received (posted) → partial/paid
   * `submitted` and `approved` are PRE-GL review states: no journal entry
   * exists yet and they are excluded from AP aging / unposted-liability KPIs.
   * When the company policy `require_bill_approval` is off, draft → received
   * remains legal and the review states are simply never used.
   */
  status: "draft" | "submitted" | "approved" | "received" | "partial" | "paid" | "overdue" | "void";
  bill_date: string;
  due_date: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  amount_paid: number;
  currency: string;
  /**
   * Exchange rate snapshot at bill date (bill currency → company base currency).
   * Used so AP can be revalued and FX gain/loss computed at payment time.
   * Defaults to 1 for company-currency bills.
   */
  currency_rate: number;
  /**
   * total × currency_rate, in company base currency. Snapshot at posting time.
   * Reports/aging always sum this column so multi-currency totals are correct.
   */
  company_currency_total: number | null;
  notes: string | null;
  /**
   * Structured payment term the bill was raised under. Snapshotted at
   * creation — never re-resolved from vendor master data, so editing a
   * supplier's default term cannot rewrite bills already entered.
   */
  payment_term_id?: string | null;
  attachment_url: string | null;
  project_id?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  vendor?: { name: string; email?: string | null } | null;
  items?: BillItem[];
}

/**
 * BillPayment is the per-bill view of a (potentially multi-bill) vendor
 * payment header. `amount` is ALWAYS the amount applied to this bill
 * (i.e. the allocation slice), so totals in payment-history dialogs add
 * up to bills.amount_paid. `total_payment_amount` is the full header
 * amount when one payment covers multiple bills. ADR 0028.
 */
export interface BillPayment {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  /** Per-bill share. Equal to the matching bill_payment_allocations.amount. */
  amount: number;
  /** Header total of the bill_payments row (== amount for single-bill). */
  total_payment_amount?: number;
  /** Number of bills settled by this payment header. */
  allocation_count?: number;
  bank_account_id: string | null;
  payment_date: string;
  payment_method: string;
  reference: string | null;
  notes: string | null;
  journal_entry_id?: string | null;
  created_by: string | null;
  created_at: string;
}

/** Row shape returned by the `find_duplicate_vendor_invoice` RPC. */
export interface DuplicateVendorInvoice {
  bill_id: string;
  bill_number: string;
  bill_date: string;
  total: number;
  status: string;
}


export function useBills() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { can } = usePermissions();
  const { postBillToGL, postToGL } = useGLPosting();
  const { getBillAccountMappings, hasRequiredAccounts, hasBillingAccounts, getMissingAccounts, accounts, isLoading: accountsLoading } = useDefaultAccounts();
  const { defaultPaymentTerm } = usePaymentTerms();
  const [bills, setBills] = useState<Bill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  /**
   * Company AP policy: when true, a bill must be approved before it can be
   * posted. The DB trigger `enforce_bill_approval_gate` is the authority —
   * this flag only shapes the UI so users are not shown an action the server
   * will refuse.
   */
  const [requireBillApproval, setRequireBillApproval] = useState(false);

  const fetchBills = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setBills([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      let q = supabase
        .from("bills")
        .select(`
          *,
          vendor:contacts(name),
          items:bill_items(*)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("bill_date", { ascending: false });
      // Branch isolation: matches active branch OR legacy NULL.
      q = applyBranchFilter(q, currentBranch?.id ?? null);
      const { data, error } = await q;

      if (error) throw error;
      const rows = (data as unknown as Bill[]) || [];
      // Dev-only contamination guard — RLS gates company, this catches branch leaks.
      assertCompanyScoped(rows, currentBusiness.id, "useBills.fetchBills");
      assertBranchScoped(rows, currentBranch?.id ?? null, "useBills.fetchBills");
      setBills(rows);
    } catch (error: any) {
      console.error("Error fetching bills:", error);
      toast({
        title: "Error loading bills",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id, toast]);

  useEffect(() => {
    fetchBills();
  }, [fetchBills]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentBusiness?.id) {
        setRequireBillApproval(false);
        return;
      }
      const { data, error } = await supabase
        .from("businesses")
        .select("require_bill_approval")
        .eq("id", currentBusiness.id)
        .maybeSingle();
      if (!cancelled && !error) {
        setRequireBillApproval(Boolean((data as any)?.require_bill_approval));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentBusiness?.id]);

  const getNextBillNumber = async (): Promise<string> => {
    if (!currentOrg) throw new Error("No organization selected");

    // Pass business + branch so the server resolves the effective prefix
    // through branch overrides AND keeps numbering sequences per branch.
    const { data, error } = await supabase.rpc("get_next_bill_number", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness?.id ?? null,
      _branch_id: currentBranch?.id ?? null,
    } as any);

    if (error) throw error;
    return data;
  };

  /**
   * Pre-submit duplicate-invoice lookup (C1).
   * The DB trigger `trg_bills_unique_vendor_invoice_number` is the hard
   * guarantee; this is the friendly warning so the user sees the clashing
   * bill BEFORE hitting a constraint error. Returns [] when the company
   * allows duplicates or nothing matches.
   */
  const findDuplicateVendorInvoice = async (
    vendorId: string,
    vendorInvoiceNumber: string,
    excludeBillId?: string,
  ): Promise<DuplicateVendorInvoice[]> => {
    if (!currentOrg || !vendorId || !vendorInvoiceNumber.trim()) return [];
    const { data, error } = await supabase.rpc("find_duplicate_vendor_invoice", {
      _org_id: currentOrg.id,
      _vendor_id: vendorId,
      _vendor_invoice_number: vendorInvoiceNumber.trim(),
      _exclude_bill_id: excludeBillId ?? null,
    } as any);
    if (error) {
      // Non-fatal: the DB trigger still blocks true duplicates on write.
      console.warn("[useBills] duplicate invoice lookup failed", error);
      return [];
    }
    return (data ?? []) as DuplicateVendorInvoice[];
  };


  /**
   * Create a bill and auto-post to GL.
   * Forces draft status internally, then immediately confirms (draft → received)
   * with proper GL posting. The user never sees draft status.
   */
  const createBill = async (
    // business_id + branch_id are injected from active context below — callers
    // should NOT supply them. currency_rate / company_currency_total are also
    // optional on input — we snapshot rate=1 by default; multi-currency
    // callers can pass an explicit rate.
    bill: Omit<
      Bill,
      | "id"
      | "organization_id"
      | "business_id"
      | "branch_id"
      | "created_at"
      | "updated_at"
      | "created_by"
      | "vendor"
      | "items"
      | "currency_rate"
      | "company_currency_total"
    > & {
      branch_id?: string | null;
      currency_rate?: number;
      company_currency_total?: number | null;
    },
    items: Omit<BillItem, "id" | "bill_id">[]
  ) => {
    if (!can("managePurchases")) { toast({ title: "Permission denied", description: "You don't have permission to create bills", variant: "destructive" }); throw new Error("Permission denied"); }
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
    const taxAmount = items.reduce((sum, item) => sum + item.tax_amount, 0);
    const total = subtotal + taxAmount - (bill.discount_amount || 0);
    // Multi-currency snapshot — defaults to 1.0 (company currency).
    const currencyRate = Number(bill.currency_rate ?? 1);
    const companyCurrencyTotal =
      bill.company_currency_total != null
        ? Number(bill.company_currency_total)
        : Number((total * currencyRate).toFixed(2));

    // Freeze the vendor's remit-to address on the bill itself. Master-data
    // edits must never rewrite the address an entered bill records.
    const remitTo = await captureRemitToSnapshot(bill.vendor_id ?? null);

    // Always insert as draft — GL posting happens on confirmation
    const { data: created, error: billError } = await supabase
      .from("bills")
      .insert({
        ...bill,
        ...remitTo,
        status: "draft", // Force draft regardless of what caller passes
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        // Stage 3: stamp the active branch so per-branch P&L attributes
        // expense correctly. Caller may override via bill.branch_id.
        branch_id: (bill as any).branch_id ?? currentBranch?.id ?? null,
        created_by: user.id,
        subtotal,
        tax_amount: taxAmount,
        total,
        currency_rate: currencyRate,
        company_currency_total: companyCurrencyTotal,
      })
      .select()
      .single();

    if (billError) throw billError;

    if (items.length > 0) {
      const itemsToInsert = items.map((item, index) => ({
        ...item,
        bill_id: created.id,
        sort_order: index,
      }));

      const { error: itemsError } = await supabase
        .from("bill_items")
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;
    }

    // Log creation
    logAction({
      action: "created",
      entityType: "bill",
      entityId: created.id,
      entityName: bill.bill_number,
      changesSummary: `Created bill ${bill.bill_number} for ${total}`,
    });

    if (requireBillApproval) {
      // Approval-gated company: the bill goes out for approval instead of
      // being posted. `enforce_bill_approval_gate` would refuse the post
      // anyway, so we never attempt it.
      const { error: submitError } = await supabase.rpc("submit_bill_atomic", {
        _bill_id: created.id,
        _actor: user.id,
      } as any);
      if (submitError) {
        toast({
          title: "Bill created as draft",
          description: `Could not submit for approval: ${normalizeError(submitError).message}`,
          variant: "destructive",
        });
      } else {
        logAction({
          action: "submitted",
          entityType: "bill",
          entityId: created.id,
          entityName: bill.bill_number,
          changesSummary: `Submitted bill ${bill.bill_number} for approval`,
        });
        toast({
          title: "Submitted for approval",
          description: `${bill.bill_number} is awaiting approval before it is posted to the ledger.`,
        });
      }
    } else {
      // Auto-confirm and post to GL immediately (atomic RPC)
      try {
        const billWithItems = { ...created, items } as unknown as Bill;
        await confirmBillAndPostGL(billWithItems, {
          logAction,
          userId: user.id,
        });
      } catch (glError: any) {
        console.error("Auto GL posting failed for bill:", glError);
        // Bill is created as draft — surface failure to user so they know to retry
        toast({
          title: "Bill created as draft",
          description: `GL posting failed: ${glError?.message || "Unknown error"}. Please confirm the bill manually from the bill list.`,
          variant: "destructive",
        });
      }
    }

    // Refresh bills from DB to get accurate status
    await fetchBills();

    // Trigger automations (fire-and-forget)
    triggerAutomation({
      event_type: "on_create",
      target_model: "bill",
      record_id: created.id,
      record_data: created,
      organization_id: currentOrg.id,
    });

    return created;
  };

  /**
   * Submit a draft bill for approval (draft → submitted).
   * No GL effect — the bill is still a pre-posting document.
   */
  const submitBillForApproval = async (id: string) => {
    if (!can("managePurchases")) { toast({ title: "Permission denied", description: "You don't have permission to submit bills", variant: "destructive" }); throw new Error("Permission denied"); }
    const bill = bills.find((b) => b.id === id);

    const { error } = await supabase.rpc("submit_bill_atomic", {
      _bill_id: id,
      _actor: user?.id ?? null,
    } as any);
    if (error) {
      toast({ title: "Cannot submit", description: normalizeError(error).message, variant: "destructive" });
      throw error;
    }

    setBills((prev) => prev.map((b) => (b.id === id ? { ...b, status: "submitted" as const } : b)));
    logAction({
      action: "submitted",
      entityType: "bill",
      entityId: id,
      entityName: bill?.bill_number,
      oldValues: { status: bill?.status },
      newValues: { status: "submitted" },
      changesSummary: `Submitted bill ${bill?.bill_number ?? id} for approval`,
    });
    toast({ title: "Submitted for approval", description: `${bill?.bill_number ?? "Bill"} is awaiting approval.` });
  };

  /**
   * Approve a submitted bill (submitted → approved). The server enforces
   * segregation of duties (the preparer cannot approve) and blocks approval
   * while an unresolved three-way match exception exists.
   */
  const approveBill = async (id: string) => {
    if (!can("managePurchases")) { toast({ title: "Permission denied", description: "You don't have permission to approve bills", variant: "destructive" }); throw new Error("Permission denied"); }
    const bill = bills.find((b) => b.id === id);

    const { error } = await supabase.rpc("approve_bill_atomic", {
      _bill_id: id,
      _actor: user?.id ?? null,
    } as any);
    if (error) {
      toast({ title: "Cannot approve", description: normalizeError(error).message, variant: "destructive" });
      throw error;
    }

    setBills((prev) => prev.map((b) => (b.id === id ? { ...b, status: "approved" as const } : b)));
    logAction({
      action: "approved",
      entityType: "bill",
      entityId: id,
      entityName: bill?.bill_number,
      oldValues: { status: bill?.status },
      newValues: { status: "approved" },
      changesSummary: `Approved bill ${bill?.bill_number ?? id}`,
    });
    toast({ title: "Bill approved", description: `${bill?.bill_number ?? "Bill"} can now be posted to the ledger.` });
  };

  /** Send a submitted/approved bill back to draft with a reason. */
  const rejectBill = async (id: string, reason: string) => {
    if (!can("managePurchases")) { toast({ title: "Permission denied", description: "You don't have permission to reject bills", variant: "destructive" }); throw new Error("Permission denied"); }
    if (!reason?.trim()) throw new Error("A rejection reason is required");
    const bill = bills.find((b) => b.id === id);

    const { error } = await supabase.rpc("reject_bill_atomic", {
      _bill_id: id,
      _reason: reason.trim(),
      _actor: user?.id ?? null,
    } as any);
    if (error) {
      toast({ title: "Cannot reject", description: normalizeError(error).message, variant: "destructive" });
      throw error;
    }

    setBills((prev) => prev.map((b) => (b.id === id ? { ...b, status: "draft" as const } : b)));
    logAction({
      action: "rejected",
      entityType: "bill",
      entityId: id,
      entityName: bill?.bill_number,
      oldValues: { status: bill?.status },
      newValues: { status: "draft" },
      changesSummary: `Rejected bill ${bill?.bill_number ?? id}. Reason: ${reason.trim()}`,
    });
    toast({ title: "Bill rejected", description: `${bill?.bill_number ?? "Bill"} was returned to draft.` });
  };

  /**
   * Confirm a bill and post to the General Ledger.
   * Transitions "draft" (or "approved", when the approval gate is on) to
   * "received" and creates journal entries.
   * Per Odoo/QuickBooks standards, only confirmed bills affect the GL.
   *
   * H3 FIX: Delegates to shared confirmBillAndPostGL module (like invoices).
   */
  const confirmBill = async (id: string) => {
    if (!can("managePurchases")) { toast({ title: "Permission denied", description: "You don't have permission to confirm bills", variant: "destructive" }); throw new Error("Permission denied"); }

    const bill = bills.find((b) => b.id === id);
    if (!bill) throw new Error("Bill not found");

    if (bill.status !== "draft" && bill.status !== "approved") {
      toast({ title: "Cannot confirm", description: "Only draft or approved bills can be confirmed", variant: "destructive" });
      throw new Error("Only draft or approved bills can be confirmed");
    }

    if (requireBillApproval && bill.status === "draft") {
      toast({
        title: "Approval required",
        description: "This company requires bills to be approved before they are posted. Submit it for approval first.",
        variant: "destructive",
      });
      throw new Error("Bill requires approval before posting");
    }

    const previousStatus = bill.status;

    // Optimistic update
    setBills((prev) =>
      prev.map((b) => (b.id === id ? { ...b, status: "received" as const } : b))
    );

    try {
      await confirmBillAndPostGL(bill, {
        logAction,
        userId: user?.id,
      });

      toast({ title: "Bill confirmed", description: `${bill.bill_number} has been confirmed and posted to the ledger.` });
    } catch (error) {
      // Rollback on error
      setBills((prev) =>
        prev.map((b) => (b.id === id ? { ...b, status: previousStatus } : b))
      );
      throw error;
    }
  };

  const updateBill = async (
    id: string,
    updates: Partial<Bill>,
    items?: Omit<BillItem, "id" | "bill_id">[]
  ) => {
    if (!can("managePurchases")) { toast({ title: "Permission denied", description: "You don't have permission to update bills", variant: "destructive" }); throw new Error("Permission denied"); }

    // Guard: prevent editing confirmed/paid/void bills (GL already posted)
    const existingBill = bills.find((b) => b.id === id);
    if (existingBill && existingBill.status !== "draft") {
      toast({ title: "Cannot edit", description: `Only draft bills can be edited. This bill is "${existingBill.status}". Void it first if changes are needed.`, variant: "destructive" });
      throw new Error("Cannot edit non-draft bill");
    }

    if (items) {
      const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
      const taxAmount = items.reduce((sum, item) => sum + item.tax_amount, 0);
      const total = subtotal + taxAmount - (updates.discount_amount || 0);

      updates.subtotal = subtotal;
      updates.tax_amount = taxAmount;
      updates.total = total;

      // Atomic: delete + insert in a single DB transaction to prevent orphaned state
      const itemsPayload = items.map((item, index) => ({
        account_id: item.account_id || null,
        product_id: item.product_id || null,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate || 0,
        tax_amount: item.tax_amount || 0,
        line_total: item.line_total,
        sort_order: index,
        project_id: (item as { project_id?: string | null }).project_id ?? null,
        task_id: (item as { task_id?: string | null }).task_id ?? null,
      }));

      const { error: itemsError } = await supabase.rpc("update_bill_items_atomic", {
        _bill_id: id,
        _items: itemsPayload,
      });

      if (itemsError) throw itemsError;
    }

    // Strip joined fields before update
    const { items: _items, vendor: _vendor, ...dbUpdates } = updates as any;
    const { error } = await supabase.from("bills").update(dbUpdates).eq("id", id);

    if (error) throw error;

    // Log update
    const bill = bills.find((b) => b.id === id);
    if (bill) {
      logAction({
        action: "updated",
        entityType: "bill",
        entityId: id,
        entityName: bill.bill_number,
        changesSummary: `Updated bill ${bill.bill_number}`,
      });
    }

    // Optimistic update
    setBills((prev) => prev.map((b) => (b.id === id ? { ...b, ...updates } : b)));
  };

  const deleteBill = async (id: string) => {
    if (!can("managePurchases")) { toast({ title: "Permission denied", description: "You don't have permission to delete bills", variant: "destructive" }); throw new Error("Permission denied"); }
    const bill = bills.find((b) => b.id === id);

    // C1 FIX: Block deletion of confirmed/posted bills to prevent orphaned GL entries
    if (bill && bill.status !== "draft") {
      toast({ title: "Cannot delete", description: "Only draft bills can be deleted. Confirmed or paid bills must be voided instead.", variant: "destructive" });
      throw new Error("Only draft bills can be deleted. Use void for confirmed bills.");
    }
    
    try {
      // First, delete related bill items
      await supabase.from("bill_items").delete().eq("bill_id", id);
      
      // Then delete the bill and verify deletion occurred
      const { data, error } = await supabase
        .from("bills")
        .delete()
        .eq("id", id)
        .select();
      
      if (error) throw error;
      
      // Check if any rows were actually deleted
      if (!data || data.length === 0) {
        throw new Error("Deletion was blocked by security policy. You may not have permission to delete this bill.");
      }

      // Only update UI after confirmed deletion
      setBills((prev) => prev.filter((b) => b.id !== id));

      // Log deletion
      if (bill) {
        logAction({
          action: "deleted",
          entityType: "bill",
          entityId: id,
          entityName: bill.bill_number,
          changesSummary: `Deleted bill ${bill.bill_number}`,
        });
      }
    } catch (error: any) {
      // Re-throw with better error message
      throw new Error(error.message || "Failed to delete bill");
    }
  };

  /**
   * Multi-bill vendor payment — ADR 0028.
   * Records ONE bill_payments header + N bill_payment_allocations + ONE JE.
   * `allocations`: each entry settles a specific bill by a positive amount;
   * sum must be <= total. All bills must belong to the same vendor/company
   * and share currency. Pass `requestId` for idempotent replay protection.
   */
  const recordMultiBillPayment = async (args: {
    vendorId: string;
    allocations: Array<{ bill_id: string; amount: number }>;
    total: number;
    payment_date: string;
    payment_method: string;
    reference?: string | null;
    notes?: string | null;
    bank_account_id?: string | null;
    branch_id?: string | null;
    requestId?: string | null;
    /** Override WHT rate. When omitted, the vendor's default rate is fetched. */
    whtRate?: number | null;
  }) => {
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization selected");

    if (accountsLoading) {
      throw new Error("Default account mappings are still loading. Please retry in a moment.");
    }
    if (!hasBillingAccounts()) {
      const missing = getMissingAccounts(["accounts_payable_id", "cash_account_id"]);
      throw new Error(
        `Cannot record bill payment: missing account mapping(s): ${missing.join(", ")}. Go to Settings > Default Accounts.`,
      );
    }
    const apAccountId = accounts.accounts_payable_id!;
    const cashAccountId = accounts.bank_account_id || accounts.cash_account_id || null;
    if (!cashAccountId) {
      throw new Error("Cash or Bank account is not mapped. Go to Settings > Default Accounts.");
    }

    // Vendor WHT rate (same for every bill in this payment — single vendor).
    let whtRate = args.whtRate ?? 0;
    if (args.whtRate === undefined) {
      try {
        const vendorDefaults = await fetchContactDefaults(args.vendorId);
        whtRate = vendorDefaults.withholding_tax_rate ?? 0;
      } catch (e) {
        console.warn("Could not load vendor WHT rate; proceeding without WHT", e);
        whtRate = 0;
      }
    }
    const whtAccountId = whtRate > 0 ? (accounts.output_tax_account_id ?? null) : null;

    const { data, error } = await supabase.rpc("record_multi_bill_payment" as any, {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
      _vendor_id: args.vendorId,
      _allocations: args.allocations,
      _total_amount: args.total,
      _payment_date: args.payment_date,
      _payment_method: args.payment_method,
      _reference: args.reference ?? null,
      _notes: args.notes ?? null,
      _created_by: user.id,
      _bank_account_id: args.bank_account_id ?? null,
      _payable_account_id: apAccountId,
      _branch_id: args.branch_id ?? currentBranch?.id ?? null,
      _request_id: args.requestId ?? null,
      _wht_rate: whtRate,
      _wht_account_id: whtAccountId,
    } as any);

    if (error) throw error;

    // Optimistic refresh — bill statuses returned by the RPC
    await fetchBills();
    return data as {
      bill_payment_id: string;
      journal_entry_id: string;
      sum_allocated: number;
      excess_amount: number;
      bill_statuses: Array<{ bill_id: string; new_status: string; new_amount_paid: number }>;
      idempotent_replay?: boolean;
    };
  };

  /**
   * Supplier advance — money out with nothing to apply it to yet (D4).
   * Mirrors `record_advance_payment` on the AR side: the cash is held as a
   * Vendor Credit (asset), never as a bill settlement. Applying it to a bill
   * later goes through `recordMultiBillPayment` like any other AP payment.
   */
  const recordVendorAdvance = async (args: {
    vendorId: string;
    amount: number;
    payment_date: string;
    payment_method?: string;
    reference?: string | null;
    notes?: string | null;
    bank_account_id?: string | null;
    branch_id?: string | null;
    requestId?: string | null;
  }) => {
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization selected");
    if (accountsLoading) {
      throw new Error("Default account mappings are still loading. Please retry in a moment.");
    }
    const cashAccountId = accounts.bank_account_id || accounts.cash_account_id || null;
    if (!cashAccountId) {
      throw new Error("Cash or Bank account is not mapped. Go to Settings > Default Accounts.");
    }

    const { data, error } = await supabase.rpc("record_vendor_advance_payment" as any, {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
      _vendor_id: args.vendorId,
      _amount: args.amount,
      _payment_date: args.payment_date,
      _payment_method: args.payment_method ?? "bank_transfer",
      _reference: args.reference ?? null,
      _notes: args.notes ?? null,
      _created_by: user.id,
      _bank_account_id: args.bank_account_id ?? null,
      _bank_gl_account_id: cashAccountId,
      _advance_asset_account_id: null,
      _branch_id: args.branch_id ?? currentBranch?.id ?? null,
      _request_id: args.requestId ?? null,
    } as any);

    if (error) throw error;
    await fetchBills();
    return data as {
      bill_payment_id: string;
      journal_entry_id: string;
      amount: number;
      idempotent_replay?: boolean;
    };
  };


  /**
   * Apply an existing supplier advance to an open bill (D6.1).
   *
   * This is NOT `recordMultiBillPayment`: the cash already left the bank
   * when the advance was recorded, so the settlement engine — which credits
   * Bank — would count the same money out twice. The dedicated RPC posts
   * Dr Accounts Payable / Cr Vendor Credits instead, the AP mirror of
   * `apply_customer_deposit_atomic`.
   */
  const applyVendorAdvance = async (args: {
    billPaymentId: string;
    billId: string;
    amount: number;
    applyDate?: string;
    clientRequestId?: string | null;
  }) => {
    if (!user) throw new Error("Not signed in");

    const { data, error } = await supabase.rpc("apply_vendor_advance_atomic" as any, {
      _bill_payment_id: args.billPaymentId,
      _bill_id: args.billId,
      _amount: args.amount,
      _apply_date: args.applyDate ?? new Date().toISOString().slice(0, 10),
      _actor: user.id,
      _client_request_id: args.clientRequestId ?? null,
    } as any);

    if (error) throw error;
    await fetchBills();
    return data as {
      event_id: string;
      journal_entry_id?: string;
      applied_amount?: number;
      bill_new_status?: string;
      advance_remaining?: number;
      idempotent_replay?: boolean;
    };
  };


  /**
   * Single-bill convenience wrapper — preserved for existing callers.
   * Internally delegates to `recordMultiBillPayment` so every AP payment
   * flows through the same allocation-aware path. ADR 0028.
   */
  const recordBillPayment = async (
    billId: string,
    payment: Omit<BillPayment, "id" | "organization_id" | "business_id" | "branch_id" | "created_at" | "created_by" | "total_payment_amount" | "allocation_count" | "journal_entry_id">,
  ) => {
    const bill = bills.find((b) => b.id === billId);
    if (!bill) throw new Error("Bill not found");
    if (!bill.vendor_id) throw new Error("Bill has no vendor — cannot record payment.");

    const result = await recordMultiBillPayment({
      vendorId: bill.vendor_id,
      allocations: [{ bill_id: billId, amount: payment.amount }],
      total: payment.amount,
      payment_date: payment.payment_date,
      payment_method: payment.payment_method,
      reference: payment.reference ?? null,
      notes: payment.notes ?? null,
      bank_account_id: payment.bank_account_id ?? null,
      branch_id: (bill as any).branch_id ?? currentBranch?.id ?? null,
    });

    logAction({
      action: "created",
      entityType: "bill",
      entityId: billId,
      entityName: bill.bill_number,
      changesSummary: `Recorded payment of ${payment.amount} for bill ${bill.bill_number}`,
    });

    return result;
  };

  /**
   * Get auto-calculated due date based on default payment terms
   */
  const getDefaultDueDate = (billDate: string): string => {
    if (defaultPaymentTerm) {
      const date = new Date(billDate);
      date.setDate(date.getDate() + defaultPaymentTerm.days);
      return date.toISOString().split("T")[0];
    }
    // No configured default term => due on receipt. We deliberately do NOT
    // invent a 30-day credit period: an unconfigured term must not silently
    // grant a month of credit and skew AP aging.
    return billDate;
  };

  /**
   * Payment history for a bill — sourced from bill_payment_allocations
   * (ADR 0028). Returns one row per allocation that touched this bill;
   * `amount` is the per-bill share so totals match bills.amount_paid.
   */
  const getBillPayments = async (billId: string): Promise<BillPayment[]> => {
    const { data, error } = await supabase
      .from("bill_payment_allocations")
      .select(`
        amount,
        bill_payment:bill_payments(
          id, organization_id, business_id, branch_id,
          bank_account_id, payment_date, amount, payment_method,
          reference, notes, journal_entry_id, created_by, created_at
        )
      `)
      .eq("bill_id", billId);

    if (error) throw error;

    // Per-payment-header allocation_count for context.
    const headerIds = Array.from(
      new Set((data || []).map((r: any) => r.bill_payment?.id).filter(Boolean)),
    );
    let headerCounts: Record<string, number> = {};
    if (headerIds.length > 0) {
      const { data: counts } = await supabase
        .from("bill_payment_allocations")
        .select("bill_payment_id")
        .in("bill_payment_id", headerIds);
      headerCounts = (counts || []).reduce((acc: Record<string, number>, row: any) => {
        acc[row.bill_payment_id] = (acc[row.bill_payment_id] || 0) + 1;
        return acc;
      }, {});
    }

    return (data || [])
      .filter((r: any) => r.bill_payment)
      .map((r: any): BillPayment => ({
        id: r.bill_payment.id,
        organization_id: r.bill_payment.organization_id,
        business_id: r.bill_payment.business_id,
        branch_id: r.bill_payment.branch_id ?? null,
        amount: Number(r.amount),
        total_payment_amount: Number(r.bill_payment.amount),
        allocation_count: headerCounts[r.bill_payment.id] ?? 1,
        bank_account_id: r.bill_payment.bank_account_id ?? null,
        payment_date: r.bill_payment.payment_date,
        payment_method: r.bill_payment.payment_method,
        reference: r.bill_payment.reference ?? null,
        notes: r.bill_payment.notes ?? null,
        journal_entry_id: r.bill_payment.journal_entry_id ?? null,
        created_by: r.bill_payment.created_by ?? null,
        created_at: r.bill_payment.created_at,
      }))
      .sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1));
  };

  /**
   * Phase 3 — void a confirmed bill through the canonical writer.
   *
   * `void_bill_atomic` owns every rule and every write: it refuses drafts,
   * settled bills and closed periods, reverses the postings through
   * `void_journal_entry_atomic`, releases the three-way match and stamps the
   * void metadata — all in one transaction.
   *
   * This hook keeps only the permission gate, the optimistic list update and the
   * audit label. Do not re-add the previous client-side sequence (status guard →
   * payment lookup → JE reversal → status write): the guards drifted from the AP
   * rules in `useTransactionReversal`, and a mid-sequence failure left the
   * ledger reversed with the bill still open.
   */
  const voidBill = async (id: string, reason = "Voided from bills list") => {
    if (!can("managePurchases")) {
      toast({ title: "Permission denied", description: "You don't have permission to void bills", variant: "destructive" });
      throw new Error("Permission denied");
    }

    const bill = bills.find((b) => b.id === id);

    const { data, error } = await supabase.rpc("void_bill_atomic" as any, {
      _bill_id: id,
      _reason: reason,
      _void_date: null,
      _actor: user?.id ?? null,
      _client_request_id: null,
    } as any);

    if (error) {
      toast({ title: "Cannot void bill", description: error.message, variant: "destructive" });
      throw error;
    }

    const result = (data ?? {}) as { result?: string; bill_number?: string | null };
    const label = result.bill_number ?? bill?.bill_number ?? id;

    setBills((prev) => prev.map((b) => (b.id === id ? { ...b, status: "void" as const } : b)));

    logAction({
      action: "voided",
      entityType: "bill",
      entityId: id,
      entityName: label,
      oldValues: { status: bill?.status },
      newValues: { status: "void" },
      changesSummary: `Voided bill ${label}. Reason: ${reason}`,
    });

    if (result.result === "already_voided") {
      toast({ title: "Already voided", description: `${label} was already voided.` });
      return;
    }

    toast({ title: "Bill voided", description: `${label} has been voided and its postings reversed.` });
  };


  // NOTE: reverseBillPayment was removed — its fabricated source_id pattern
  // bypassed the uniq_je_per_source guard and didn't mark the original JE
  // as reversed. Use useTransactionReversal.voidBillPayment instead, which
  // mirrors the original JE lines exactly and links the reversal back via
  // reversal_of_id. See SOURCE TYPE TAXONOMY in useGLPosting.ts.

  return {
    bills,
    isLoading,
    requireBillApproval,
    getNextBillNumber,
    findDuplicateVendorInvoice,
    createBill,
    submitBillForApproval,
    approveBill,
    rejectBill,
    confirmBill,
    updateBill,
    deleteBill,
    voidBill,
    recordBillPayment,
    recordMultiBillPayment,
    recordVendorAdvance,
    applyVendorAdvance,

    getBillPayments,
    getDefaultDueDate,
    refreshBills: fetchBills,
  };
}
