import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useBranch } from "@/contexts/BranchContext";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";
import { createCreditNoteAtomic, issueCreditNoteAtomic } from "@/services/finance/createCreditNote";

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

export function useCreditNotes() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
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
    if (!currentBusiness) throw new Error("No company selected");

    const { data, error } = await supabase.rpc("get_next_credit_note_number", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
      _branch_id: currentBranch?.id ?? null,
    } as any);

    if (error) throw error;
    return data as unknown as string;
  };

  const createCreditNote = async (
    creditNote: Omit<CreditNote, "id" | "organization_id" | "created_at" | "updated_at" | "created_by" | "contact" | "invoice" | "items" | "source_return">,
    items: Array<Record<string, unknown>>,
    /** Idempotency key: repeat submissions of the same intent are collapsed. */
    clientRequestId?: string,
  ) => {
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    // ADR 0131: header, lines, number, GL post and customer-credit movement
    // all happen inside one server transaction. The client never computes
    // totals-of-record and never picks accounts.
    // `create_credit_note_atomic(_payload jsonb)` is the ONLY credit note
    // creation entry point. The single named envelope keeps the PostgREST
    // signature stable as the document evolves; no adapters, no overloads.
    const data = await createCreditNoteAtomic({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: (creditNote as any).branch_id ?? currentBranch?.id ?? null,
        contact_id: creditNote.contact_id,
        invoice_id: creditNote.invoice_id ?? null,
        issue_date: creditNote.issue_date ?? new Date().toISOString().split("T")[0],
        reason: creditNote.reason ?? null,
        notes: creditNote.notes ?? null,
        items: items.map((item, index) => ({ ...item, sort_order: (item as any).sort_order ?? index })),
        source_return_id: creditNote.source_return_id ?? null,
        issue: creditNote.status === "issued",
        client_request_id: clientRequestId ?? null,
    });

    await fetchCreditNotes();
    const result = data as { credit_note_id: string; credit_note_number: string };
    return { id: result.credit_note_id, credit_note_number: result.credit_note_number };

  };

  /**
   * Issue a draft credit note. The server decides whether the credit reduces
   * the receivable (invoice still open) or becomes customer credit (invoice
   * settled, or no invoice at all).
   */
  const issueCreditNote = async (cnId: string) => {
    const data = await issueCreditNoteAtomic(cnId);
    await fetchCreditNotes();
    return data;
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

    const { data, error } = await (supabase.rpc as any)("apply_credit_to_invoice_atomic", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness?.id || null,
      _credit_note_id: creditNoteId,
      _invoice_id: invoiceId,
      _amount: amount,
      _applied_by: user.id,
      _notes: notes || null,
      // Accounts are resolved server-side (ADR 0131); branch is a fallback for
      // orphaned rows — the RPC prefers the invoice's branch.
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
    notes?: string,
    /**
     * Phase 7 — idempotency key owned by the caller (one key per user
     * submission, reused across retries). A timestamp here would let a
     * retried refund pay the customer twice.
     */
    clientRequestId?: string,
  ) => {
    if (!currentOrg || !user) throw new Error("Not authenticated");

    const cn = creditNotes.find((c) => c.id === creditNoteId);
    if (!cn) throw new Error("Credit note not found");

    // ADR 0131: one refund engine for payments and credit notes. It drains the
    // customer-credit liability, records a credit movement, writes the
    // `customer_refunds` row and posts the cash-out JE in one transaction.
    const { error } = await (supabase.rpc as any)("refund_customer_atomic", {
      _source: "credit_note",
      _source_id: creditNoteId,
      _bank_account_id: paymentAccountId,
      _amount: amount,
      _refund_date: new Date().toISOString().split("T")[0],
      _reason_code: "customer_refund_requested",
      _reason_text: notes || `Refund of credit note ${cn.credit_note_number}`,
      _payment_method: method,
      _reference: cn.credit_note_number,
      _client_request_id:
        clientRequestId ?? `cn-refund-${creditNoteId}-${amount.toFixed(2)}`,
    });
    if (error) throw new Error(`Refund failed: ${error.message}`);
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
