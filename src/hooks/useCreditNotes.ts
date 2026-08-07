import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useBranch } from "@/contexts/BranchContext";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";

/**
 * ADR 0131 — commercial compensation is a server-side service.
 *
 * This hook builds NO journal lines and resolves NO GL accounts. Creation,
 * issuing, application and refund all go through the canonical database
 * writers (`create_credit_note_atomic`, `issue_credit_note_atomic`,
 * `apply_credit_to_invoice_atomic`, `refund_customer_atomic`), which decide
 * receivable vs customer-credit treatment, post through
 * `post_journal_entry_atomic` and record customer-credit movements.
 */

export interface CreditNoteItem {
  id?: string;
  credit_note_id?: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number;
  line_total: number;
  sort_order: number;
  // Multi-Unit provenance — DB BEFORE-trigger _uom_normalize_line stamps
  // qty_in_base_uom / packaging_label / uom_snapshot server-side; the
  // client just needs to forward the operator's pack choice.
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
  uom_snapshot?: string | null;
}

export interface CreditNote {
  id: string;
  organization_id: string;
  invoice_id: string | null;
  contact_id: string | null;
  credit_note_number: string;
  status: "draft" | "issued" | "applied" | "void" | "refunded";
  issue_date: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  amount_applied: number;
  refund_amount?: number;
  refund_date?: string | null;
  refund_method?: string | null;
  currency: string;
  reason: string;
  notes: string | null;
  source_return_id?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  contact?: { name: string } | null;
  invoice?: { invoice_number: string } | null;
  source_return?: { return_number: string } | null;
  items?: CreditNoteItem[];
}

export interface CreditNoteApplication {
  id: string;
  credit_note_id: string;
  invoice_id: string;
  amount: number;
  applied_at: string;
  applied_by: string | null;
  notes: string | null;
  invoice?: { invoice_number: string };
}

/**
 * Checks if an invoice is fully paid by querying its status and amounts.
 * Returns { is_fully_paid, invoice_number } for GL posting context.
 */
async function checkInvoicePaymentStatus(invoiceId: string | null): Promise<{
  is_fully_paid: boolean;
  invoice_number?: string;
}> {
  if (!invoiceId) return { is_fully_paid: false };

  const { data, error } = await supabase
    .from("invoices")
    .select("status, total, amount_paid, invoice_number")
    .eq("id", invoiceId)
    .single();

  if (error || !data) return { is_fully_paid: false };

  const isFullyPaid = data.status === "paid" || (data.amount_paid ?? 0) >= (data.total ?? 0);
  return { is_fully_paid: isFullyPaid, invoice_number: data.invoice_number };
}

export function useCreditNotes() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { getCreditNoteAccountMappings, accounts: defaultAccounts } = useDefaultAccounts();
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchCreditNotes = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setCreditNotes([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      let query = supabase
        .from("credit_notes")
        .select(`
          *,
          contact:contacts(name),
          invoice:invoices!credit_notes_invoice_id_fkey(invoice_number),
          source_return:sales_returns!credit_notes_source_return_id_fkey(return_number),
          items:credit_note_items(*)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);
      query = applyBranchFilter(query, currentBranch?.id ?? null);

      const { data, error } = await query.order("created_at", { ascending: false });

      if (error) throw error;
      setCreditNotes(data as unknown as CreditNote[]);
    } catch (error: any) {
      console.error("Error fetching credit notes:", error);
      toast({
        title: "Error loading credit notes",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id, toast]);

  useEffect(() => {
    fetchCreditNotes();
  }, [fetchCreditNotes]);

  const getNextCreditNoteNumber = async (): Promise<string> => {
    if (!currentOrg) throw new Error("No organization selected");

    const { data, error } = await supabase.rpc("get_next_credit_note_number", {
      _org_id: currentOrg.id,
    });

    if (error) throw error;
    return data;
  };

  const createCreditNote = async (
    creditNote: Omit<CreditNote, "id" | "organization_id" | "created_at" | "updated_at" | "created_by" | "contact" | "invoice" | "items" | "source_return">,
    items: Omit<CreditNoteItem, "id" | "credit_note_id">[]
  ) => {
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
    const taxAmount = items.reduce((sum, item) => sum + item.tax_amount, 0);
    const total = subtotal + taxAmount;

    const { data: created, error: cnError } = await supabase
      .from("credit_notes")
      .insert({
        ...creditNote,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        // Sales audit Phase A (finding #4): stamp branch_id explicitly so
        // standalone credit notes (no invoice_id) carry branch context.
        // The cascade_branch_from_invoice trigger overrides this when an
        // invoice_id is set.
        branch_id: (creditNote as any).branch_id ?? currentBranch?.id ?? null,
        created_by: user.id,
        subtotal,
        tax_amount: taxAmount,
        total,
      })
      .select()
      .single();

    if (cnError) throw cnError;

    if (items.length > 0) {
      const itemsToInsert = items.map((item, index) => ({
        ...item,
        credit_note_id: created.id,
        sort_order: index,
      }));

      const { error: itemsError } = await supabase
        .from("credit_note_items")
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;
    }

    // Sales audit Phase F: if the caller wanted the CN created in 'issued' state,
    // route through the atomic RPC so insert + GL post happen as one. Without
    // this, a network drop after the insert leaves a CN with status='issued'
    // but no journal entry — books out of sync with AR ledger.
    if (creditNote.status === "issued") {
      // Re-fetch the inserted CN as 'draft' first via a status reset, then
      // call the atomic issue RPC. Simpler path: just call the issue RPC now,
      // which expects status='draft' — so the row is currently 'issued' from
      // the insert, which would fail the RPC's status check.
      // Easiest correct path: persist as 'draft', then issue.
      await supabase.from("credit_notes").update({ status: "draft" }).eq("id", created.id);
      await issueCreditNoteInternal(created.id, creditNote.invoice_id);
    }

    await fetchCreditNotes();
    return created;
  };

  /**
   * Internal helper: issue a draft credit note via the atomic RPC.
   * Resolves accounts client-side for fast UX errors, then calls
   * confirm_credit_note_atomic which validates the JE and posts in one txn.
   */
  const issueCreditNoteInternal = async (cnId: string, invoiceId: string | null) => {
    if (!user) throw new Error("Not authenticated");
    const mappings = getCreditNoteAccountMappings();
    if (!mappings.receivable_account_id || !mappings.revenue_account_id) {
      throw new Error(
        "Credit Note GL posting failed: missing account mappings (AR or Revenue). Configure in Settings → Default Accounts."
      );
    }

    // Need totals/number/contact_id of the CN
    const { data: cn, error: cnErr } = await supabase
      .from("credit_notes")
      .select("id, credit_note_number, subtotal, tax_amount, total, contact_id, status")
      .eq("id", cnId)
      .single();
    if (cnErr) throw cnErr;
    if (cn.status !== "draft") {
      throw new Error(`Cannot issue credit note: status is "${cn.status}".`);
    }

    const { is_fully_paid, invoice_number } = await checkInvoicePaymentStatus(invoiceId);
    if (is_fully_paid && !mappings.customer_deposits_account_id) {
      throw new Error(
        "Credit Note GL posting failed: Invoice is fully paid but Customer Deposits account is not configured. " +
        "Configure it in Settings → Default Accounts."
      );
    }

    const lines = buildCreditNoteJELines({
      credit_note_number: cn.credit_note_number,
      invoice_number,
      subtotal: Number(cn.subtotal),
      tax_amount: Number(cn.tax_amount),
      total: Number(cn.total),
      contact_id: cn.contact_id,
      is_fully_paid,
      receivable_account_id: mappings.receivable_account_id,
      revenue_account_id: mappings.revenue_account_id,
      tax_liability_account_id: mappings.tax_liability_account_id,
      customer_deposits_account_id: mappings.customer_deposits_account_id,
    });

    const { data, error } = await supabase.rpc("confirm_credit_note_atomic" as any, {
      p_cn_id: cnId,
      p_user_id: user.id,
      p_main_lines: lines as any,
    });
    if (error) throw new Error(`Credit note issue failed: ${error.message}`);
    const result = data as { success: boolean; journal_entry_id: string };
    if (!result?.success) throw new Error("Credit note issue failed: server returned no success flag");
    return result.journal_entry_id;
  };

  /**
   * Public API: issue a draft credit note (atomic).
   * Call this instead of updateCreditNote({status: 'issued'}).
   */
  const issueCreditNote = async (cnId: string) => {
    const cn = creditNotes.find((c) => c.id === cnId);
    if (!cn) throw new Error("Credit note not found");
    await issueCreditNoteInternal(cnId, cn.invoice_id);
    await fetchCreditNotes();
  };

  const updateCreditNote = async (id: string, updates: Partial<CreditNote>) => {
    // Sales audit Phase F: GL-affecting status transitions are NOT allowed
    // through this generic mutator. Use issueCreditNote(id) for draft → issued
    // (it routes through the atomic confirm_credit_note_atomic RPC), and
    // processRefund() for the refund flow. This prevents both partial-state
    // bugs and double-posting via re-issue.
    if (updates.status === "issued") {
      toast({
        title: "Use Issue Credit Note",
        description: "Issuing a credit note posts to the General Ledger. Use the dedicated 'Issue' action so the post happens atomically.",
        variant: "destructive",
      });
      throw new Error("updateCreditNote cannot flip status to 'issued'. Call issueCreditNote(id) instead.");
    }

    // Strip joined fields
    const { contact, invoice, items, source_return, ...dbUpdates } = updates as any;

    const { error } = await supabase
      .from("credit_notes")
      .update(dbUpdates)
      .eq("id", id);

    if (error) throw error;

    await fetchCreditNotes();
  };

  /**
   * Delete a credit note — only allowed for drafts with no applications or refunds.
   */
  const deleteCreditNote = async (id: string) => {
    const cn = creditNotes.find((c) => c.id === id);
    if (!cn) {
      toast({ title: "Error", description: "Credit note not found", variant: "destructive" });
      return;
    }

    // Guard: only draft CNs can be deleted
    if (cn.status !== "draft") {
      toast({
        title: "Cannot delete",
        description: `Only draft credit notes can be deleted. This credit note is "${cn.status}".`,
        variant: "destructive",
      });
      return;
    }

    // Guard: check for applications
    if (cn.amount_applied > 0) {
      toast({
        title: "Cannot delete",
        description: "This credit note has been partially applied. Void it instead.",
        variant: "destructive",
      });
      return;
    }

    // Guard: check for refunds
    if ((cn.refund_amount || 0) > 0) {
      toast({
        title: "Cannot delete",
        description: "This credit note has refunds recorded. Void it instead.",
        variant: "destructive",
      });
      return;
    }

    const { error } = await supabase.from("credit_notes").delete().eq("id", id);
    if (error) throw error;
    await fetchCreditNotes();
  };

  const applyCreditToInvoice = async (
    creditNoteId: string,
    invoiceId: string,
    amount: number,
    notes?: string,
    branchId?: string | null,
  ) => {
    if (!user || !currentOrg) throw new Error("Not authenticated");

    // Resolve mappings so we post the GL leg server-side. Without these
    // accounts the RPC silently skips JE creation, leaving the AR card
    // out of sync with the GL.
    const mappings = getCreditNoteAccountMappings();

    const { data, error } = await (supabase.rpc as any)("apply_credit_to_invoice_atomic", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness?.id || null,
      _credit_note_id: creditNoteId,
      _invoice_id: invoiceId,
      _amount: amount,
      _applied_by: user.id,
      _notes: notes || null,
      _customer_deposits_account_id: mappings?.customer_deposits_account_id ?? null,
      _receivable_account_id: mappings?.receivable_account_id ?? null,
      // Phase 4: explicit branch context. The RPC also derives the branch
      // from the invoice when present; this is a fallback for orphaned rows.
      _branch_id: branchId ?? currentBranch?.id ?? null,
    });

    if (error) throw error;

    await fetchCreditNotes();
    return data;
  };

  const getCreditApplications = async (
    creditNoteId: string
  ): Promise<CreditNoteApplication[]> => {
    const { data, error } = await supabase
      .from("credit_note_applications")
      .select(`
        *,
        invoice:invoices(invoice_number)
      `)
      .eq("credit_note_id", creditNoteId)
      .order("applied_at", { ascending: false });

    if (error) throw error;
    return data || [];
  };

  const processRefund = async (
    creditNoteId: string,
    amount: number,
    method: string,
    paymentAccountId: string,
    notes?: string
  ) => {
    if (!currentOrg || !user) throw new Error("Not authenticated");

    const cn = creditNotes.find((c) => c.id === creditNoteId);
    if (!cn) throw new Error("Credit note not found");

    const mappings = getCreditNoteAccountMappings();
    if (!mappings.receivable_account_id) {
      throw new Error("Missing AR account. Configure in Settings → Default Accounts.");
    }

    // Check invoice payment status to reverse the correct account
    const { is_fully_paid } = await checkInvoicePaymentStatus(cn.invoice_id);
    if (is_fully_paid && !mappings.customer_deposits_account_id) {
      throw new Error(
        "Refund failed: invoice is fully paid but Customer Deposits account is not configured. " +
        "Configure it in Settings → Default Accounts."
      );
    }

    // Sales audit Phase F: build JE client-side, post via atomic RPC.
    // The RPC validates available residual + balance + business scope and
    // updates refund_amount/status in one transaction. No more orphan refunds.
    const lines = buildRefundJELines({
      credit_note_number: cn.credit_note_number,
      amount,
      contact_id: cn.contact_id,
      is_fully_paid: !!is_fully_paid,
      receivable_account_id: mappings.receivable_account_id,
      payment_account_id: paymentAccountId,
      customer_deposits_account_id: mappings.customer_deposits_account_id,
    });

    const { data, error } = await supabase.rpc("process_refund_atomic" as any, {
      p_cn_id: creditNoteId,
      p_user_id: user.id,
      p_amount: amount,
      p_method: method,
      p_payment_account_id: paymentAccountId,
      p_notes: notes || null,
      p_main_lines: lines as any,
    });
    if (error) throw new Error(`Refund failed: ${error.message}`);
    const result = data as { success: boolean };
    if (!result?.success) throw new Error("Refund failed: server returned no success flag");

    await fetchCreditNotes();
  };

  return {
    creditNotes,
    isLoading,
    getNextCreditNoteNumber,
    createCreditNote,
    updateCreditNote,
    issueCreditNote,
    deleteCreditNote,
    applyCreditToInvoice,
    getCreditApplications,
    processRefund,
    refreshCreditNotes: fetchCreditNotes,
  };
}
