import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { useGLPosting } from "./useGLPosting";
import { useDefaultAccounts } from "./useDefaultAccounts";
import { normalizeError } from "@/services/resilience";

/**
 * ADR 0012 — payment_reversal_reason enum mirrored in TS.
 * Every reversal entry-point now requires a reason code so the audit log
 * captures business intent (not just "it happened").
 */
export type PaymentReversalReason =
  | "data_entry_error"
  | "duplicate_payment"
  | "bank_transfer_failed"
  | "wrong_invoice_applied"
  | "customer_refund_requested"
  | "invoice_cancelled_keep_as_credit"
  | "invoice_cancelled_keep_as_advance"
  | "pre_refund_unapply"
  | "payment_currency_mismatch";

export interface IssueCreditNoteForPaymentOptions {
  paymentId: string;
  reason: string;
  reversalDate?: string;
  clientRequestId?: string;
}

export interface ApplyCustomerDepositOptions {
  paymentId: string;
  invoiceId: string;
  amount: number;
  applyDate?: string;
  clientRequestId?: string;
}

export interface VoidPaymentOptions {
  paymentId: string;
  reason: string;
  voidDate?: string;
  /**
   * ADR 0012 reason code. Required by the new wizard path; legacy call sites
   * that omit it get a deprecation warning and default to `data_entry_error`
   * (full reversal). Will become required in P3.
   */
  reasonCode?: PaymentReversalReason;
  clientRequestId?: string;
}

export interface UnapplyPaymentOptions {
  paymentId: string;
  reasonCode: PaymentReversalReason;
  reason: string;
  reversalDate?: string;
  clientRequestId?: string;
}

export interface RefundCustomerOptions {
  source: "payment" | "credit_note";
  sourceId: string;
  bankAccountId: string;
  amount: number;
  refundDate?: string;
  reasonCode: PaymentReversalReason;
  reason: string;
  paymentMethod?: string;
  reference?: string;
  clientRequestId?: string;
}

/**
 * Phase 1 reversal intent policy — mirror of `public.resolve_reversal_intent`.
 *
 * The database decides which reversal operation is legal for a document given
 * its settlement state, bank-reconciliation state and accounting period state.
 * Surfaces render what it returns; they never compute legality themselves.
 */
/**
 * Every document type the intent policy and the consequence preview understand.
 * Sales: invoice, payment. Purchases (Phase 3): bill, bill_payment,
 * goods_receipt. Keep in step with `resolve_reversal_intent`'s branches — the
 * function raises for anything it does not know.
 */
export type ReversalDocumentType =
  | "invoice"
  | "payment"
  | "bill"
  | "bill_payment"
  | "goods_receipt"
  /** ADR 0132 Phase 4 — reversal of a posted vendor credit note. */
  | "vendor_credit_note"
  /** ADR 0134 — expense void goes through intent + preview like every other reversal. */
  | "expense";

export type ReversalOperation =
  | "void"
  | "credit_note"
  | "vendor_credit_note"
  | "goods_return"
  | "refund"
  | "customer_credit"
  | "reverse_payment"
  | "none";

export type ReversalBlocker =
  | "already_reversed"
  | "settled"
  /** goods receipt already turned into a supplier bill */
  | "billed"
  | "bank_reconciled"
  | "period_closed";


export interface ReversalOperationOption {
  operation: ReversalOperation;
  allowed: boolean;
  label: string;
  description?: string | null;
  blocked_reason?: string | null;
}

export interface ReversalIntent {
  document_type: ReversalDocumentType;
  document_id: string;
  document_number: string;
  status: string;
  organization_id: string | null;
  business_id: string | null;
  total: number;
  amount_settled: number;
  state: {
    already_reversed: boolean;
    is_draft: boolean;
    is_posted: boolean;
    is_settled: boolean;
    live_payment_count: number;
    live_payment_total: number;
    is_bank_reconciled: boolean;
    period_open: boolean;
  };
  blockers: ReversalBlocker[];
  recommended: ReversalOperation;
  operations: ReversalOperationOption[];
}

/**
 * Phase 2 consequence preview — mirror of
 * `public.preview_reversal_consequences`.
 *
 * Read-only projection of everything a reversal would touch: the mirrored GL
 * legs, the stock that returns to inventory, the money that changes hands, the
 * documents already derived from this one, and the business warnings.
 *
 * Never re-derive any of these numbers in the client. The server walks the same
 * predicates the void writers walk; a second client-side derivation would drift.
 */
export type ReversalWarningSeverity = "error" | "warning" | "info";

export interface ReversalWarning {
  code: string;
  severity: ReversalWarningSeverity;
  message: string;
}

export interface ReversalGlLine {
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  /** Already inverted: the shape of the reversal, not of the original entry. */
  reverse_debit: number;
  reverse_credit: number;
}

export interface ReversalGlEntry {
  journal_entry_id: string;
  entry_number: string | null;
  entry_date: string | null;
  subtype: string;
  total: number;
  status: string;
  lines: ReversalGlLine[];
}

export interface ReversalStockLine {
  product_id: string;
  product_name: string | null;
  product_sku: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  quantity: number;
  unit_cost: number | null;
  direction: string;
}

/** Invoice branch: the payments currently settling this invoice. */
export interface ReversalMoneyPaymentLine {
  payment_id: string;
  receipt_number: string | null;
  payment_date: string | null;
  payment_method: string | null;
  allocated_amount: number;
  payment_amount: number;
  bank_reconciled: boolean;
}

/** Payment branch: the invoices this payment settles, before and after. */
export interface ReversalMoneyInvoiceLine {
  invoice_id: string;
  invoice_number: string | null;
  invoice_total: number;
  allocated_amount: number;
  amount_paid_now: number;
  amount_paid_after: number;
  status_now: string;
}

export type ReversalMoneyLine = ReversalMoneyPaymentLine | ReversalMoneyInvoiceLine;

export interface ReversalRelatedDocument {
  kind: string;
  label: string;
  count: number;
}

/**
 * Phase 4 — warehouse participation.
 *
 * Open floor work belonging to the document. Reversing it cancels these tasks
 * through `wms_cancel_tasks_for_document`; the client never flips task state.
 */
export interface ReversalWarehouseTask {
  task_id: string;
  task_type: string;
  state: string;
  warehouse_id: string | null;
  product_id: string | null;
  quantity: number | null;
  assignee_user_id: string | null;
}

/**
 * Phase 4 — bank reconciliation participation.
 *
 * The reconciled statement lines matched to this document's payments. While any
 * line is listed, the reversal is blocked: un-match it first through
 * `resolve_reversal_bank_block`.
 */
export interface ReversalBankLine {
  bank_transaction_id: string;
  bank_account_id: string | null;
  transaction_date: string | null;
  description: string | null;
  amount: number;
  reconciled_type: string | null;
  payment_id: string | null;
  payment_kind: "payment" | "bill_payment";
}

export interface ReversalConsequences {
  document_type: ReversalDocumentType;
  document_id: string;
  document_number: string | null;
  organization_id: string | null;
  business_id: string | null;
  intent: ReversalIntent;
  gl: {
    entries: ReversalGlEntry[];
    entry_count: number;
    total_reversed: number;
  };
  stock: {
    lines: ReversalStockLine[];
    line_count: number;
  };
  money: {
    lines: ReversalMoneyLine[];
    line_count: number;
  };
  warehouse: {
    tasks: ReversalWarehouseTask[];
    task_count: number;
    in_progress_count: number;
  };
  bank: {
    lines: ReversalBankLine[];
    line_count: number;
  };
  related_documents: ReversalRelatedDocument[];
  warnings: ReversalWarning[];
}


export interface VoidInvoiceOptions {

  invoiceId: string;
  reason: string;
  /** Code from `reversal_reason_codes` (ADR 0129) — validated server-side. */
  reasonCode: string;
  voidDate?: string;
  clientRequestId?: string;
}


export interface VoidBillOptions {
  billId: string;
  reason: string;
  /** Code from `reversal_reason_codes` (ADR 0129) — validated server-side. */
  reasonCode: string;
  voidDate?: string;
}

export interface VoidBillPaymentOptions {
  billPaymentId: string;
  reason: string;
  /** Code from `reversal_reason_codes` (ADR 0129) — validated server-side. */
  reasonCode: string;
  voidDate?: string;
  clientRequestId?: string;
}


/**
 * @deprecated ADR 0012 Wave R2 — the legacy unreconcile path is gone from
 * the UI. The wizard (`ReversePaymentWizard` → `unapplyPayment`) now owns
 * the "wrong invoice applied" intent and parks cash on Customer Deposits
 * instead of reversing the original cash receipt JE. This interface is
 * kept only for the internal `reapplyPayment` shape compatibility.
 */
export interface UnreconcilePaymentOptions {
  paymentId: string;
  reason: string;
}

export interface ReapplyPaymentOptions {
  paymentId: string;
  newInvoiceId: string;
  reason: string;
}

type InvoiceStatus = "draft" | "sent" | "viewed" | "partial" | "paid" | "overdue" | "cancelled" | "voided";
type PaymentStatus = "applied" | "voided" | "unreconciled";

/**
 * Hook for transaction reversal operations.
 *
 * SINGLE SOURCE OF TRUTH (post-audit):
 *   Every reversal path here delegates to the canonical
 *   `void_journal_entry_atomic` RPC. The RPC:
 *     - Inserts a reversal sub-entry (source_subtype='reversal') in ONE
 *       transaction with the line trigger applying balance updates.
 *     - Marks the original JE status='reversed' and links reversed_by_id.
 *     - Is idempotent (concurrent calls return the same reversal id).
 *     - NEVER mutates the original JE's lines, accounts, or amounts.
 *
 * RULES:
 *   - DO NOT call `.from("journal_entries").update({reversal_of_id...})`.
 *   - DO NOT call `.from("journal_entries").update({status:'voided'/'reversed'})`.
 *   - DO NOT manually post a flipped JE via postToGL — the RPC does that.
 */

/**
 * Reverse a posted journal entry via the canonical atomic RPC.
 * Throws on failure so callers leave the source document in its original state.
 */
async function reverseJEAtomic(
  journalEntryId: string,
  reason: string,
  userId: string | null,
  reversalDate?: string
): Promise<string> {
  const { data, error } = await supabase.rpc("void_journal_entry_atomic", {
    _entry_id: journalEntryId,
    _reason: reason,
    _user_id: userId,
    _entry_number: null,
    _reversal_date: reversalDate ?? null,
  } as any);
  if (error) throw error;
  if (!data) throw new Error("Reversal RPC returned no id");
  return data as string;
}

/**
 * ADR 0027 — allocation-aware helpers used by every payment reversal path.
 *
 * `payment_allocations` is the canonical link between a payment and the
 * invoices it settles. Every void / unapply / reapply path must walk
 * allocations instead of the deprecated single-invoice FK on payments (see ADR 0027)
 * (scheduled to be dropped in M-5).
 *
 * Trigger contract (migration 20260602040151):
 *   - `trg_payment_alloc_sum_invariant` is DEFERRABLE INITIALLY DEFERRED and
 *     RETURNs NULL when `payment.status IN ('voided','cancelled','unreconciled')`.
 *     => Flip `payment.status` FIRST, then mutate allocations.
 *   - `payment_allocations.amount` is CHECK (amount > 0) — no negative
 *     compensating rows. Unapply DELETEs rows; void leaves them as
 *     historical record (the ledger view filters by `payment.status`).
 */
interface LiveAllocation {
  id: string;
  invoice_id: string;
  amount: number;
}

async function fetchLiveAllocations(paymentId: string): Promise<LiveAllocation[]> {
  const { data, error } = await supabase
    .from("payment_allocations")
    .select("id, invoice_id, amount")
    .eq("payment_id", paymentId);
  if (error) throw error;
  return (data || []).map((r) => ({
    id: (r as any).id as string,
    invoice_id: (r as any).invoice_id as string,
    amount: Number((r as any).amount) || 0,
  }));
}

// NOTE: the client-side `decrementInvoicePaid` helper was removed. Invoice
// paid amounts are now recomputed inside `void_payment_atomic` and
// `unreconcile_payment_atomic` from the live allocation sum, so the browser
// never writes `invoices.amount_paid` on a reversal path.


export function useTransactionReversal() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { postPaymentToGL } = useGLPosting();
  const { getInvoiceAccountMappings, getPaymentAccountMappings } = useDefaultAccounts();


  /**
   * Void a payment — reverses the linked JE atomically and updates the invoice balance.
   * FLOW: GL reversal FIRST → then status update.
   */
  const voidPayment = async (options: VoidPaymentOptions): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }

    // ADR 0012: intent capture is mandatory. Callers must mount
    // ReversePaymentWizard, which generates the reasonCode from the
    // operator's plain-language answer. Anything else is a programming
    // error — fail loudly rather than silently coding it as a data entry
    // error and corrupting the audit trail.
    if (!options.reasonCode) {
      const msg =
        "[ADR 0012] voidPayment requires a reasonCode. " +
        "Mount ReversePaymentWizard instead of calling voidPayment directly.";
      console.error(msg);
      toast({
        title: "Reversal blocked",
        description: "Use the guided reversal wizard so we can capture intent.",
        variant: "destructive",
      });
      return false;
    }
    const reasonCode: PaymentReversalReason = options.reasonCode;

    try {
      const { data: payment, error: paymentError } = await supabase
        .from("payments")
        .select("*")
        .eq("id", options.paymentId)
        .single();

      if (paymentError) throw paymentError;
      if (!payment) throw new Error("Payment not found");

      const paymentStatus = (payment as { status?: PaymentStatus }).status;
      if (paymentStatus === "voided") {
        toast({ title: "Already Voided", description: "This payment has already been voided", variant: "destructive" });
        return false;
      }

      const voidDate = options.voidDate || new Date().toISOString().split("T")[0];

      // Labels only. `void_payment_atomic` owns the whole operation: JE
      // reversal, status flip, per-invoice recompute and the reason-coded
      // event, in one transaction. Never re-split this into client steps —
      // a failure mid-sequence used to leave the GL reversed while invoices
      // still counted the cash.
      const allocations = await fetchLiveAllocations(options.paymentId);

      const { error: voidError } = await supabase.rpc("void_payment_atomic" as any, {
        _payment_id: options.paymentId,
        _reason: options.reason,
        _reason_code: reasonCode,
        _void_date: voidDate,
        _actor: user.id,
        _client_request_id: options.clientRequestId ?? null,
      } as any);
      if (voidError) throw voidError;


      logAction({
        action: "voided",
        entityType: "payment",
        entityId: options.paymentId,
        entityName: (payment as any).receipt_number,
        changesSummary: `Payment voided (${reasonCode}). Reason: ${options.reason}. Amount: ${(payment as any).amount}. Allocations reverted: ${allocations.length}`,
      });

      toast({ title: "Payment Voided", description: `Payment ${(payment as any).receipt_number} has been voided and GL entries reversed` });
      return true;
    } catch (error: any) {
      console.error("Error voiding payment:", error);
      toast({ title: "Error Voiding Payment", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };

  /**
   * Resolve which reversal operation is LEGAL for a document.
   *
   * Phase 1 reversal intent policy: `resolve_reversal_intent` in the database
   * is the only authority on this. Never re-derive "can I void this?" in the
   * client from `amount_paid`, a status string or a period lookup — settlement,
   * bank reconciliation and period state are server truth.
   */
  const resolveReversalIntent = async (
    documentType: ReversalDocumentType,
    documentId: string
  ): Promise<ReversalIntent | null> => {
    const { data, error } = await supabase.rpc("resolve_reversal_intent" as any, {
      _document_type: documentType,
      _document_id: documentId,
    } as any);
    if (error) {
      console.error("Error resolving reversal intent:", error);
      toast({
        title: "Could not check this document",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      return null;
    }
    return (data as unknown as ReversalIntent) ?? null;
  };

  /**
   * Project what a reversal would do, before anyone authorises it.
   *
   * Phase 2 consequence preview: `preview_reversal_consequences` is read-only
   * (STABLE) and walks the same predicates the void writers walk, so the numbers
   * shown are the numbers that will post. Do not compute GL, stock or settlement
   * figures in the client — a second derivation drifts from the writer.
   */
  const previewReversalConsequences = async (
    documentType: ReversalDocumentType,
    documentId: string
  ): Promise<ReversalConsequences | null> => {
    const { data, error } = await supabase.rpc("preview_reversal_consequences" as any, {
      _document_type: documentType,
      _document_id: documentId,
    } as any);
    if (error) {
      console.error("Error previewing reversal consequences:", error);
      return null;
    }
    return (data as unknown as ReversalConsequences) ?? null;
  };

  /**
   * Phase 4 — clear the `bank_reconciled` blocker the legal way.
   *
   * `resolve_reversal_bank_block` un-matches exactly the statement lines the
   * preview listed, through the canonical `unreconcile_bank_transaction` writer
   * (which voids the reconciliation JE, reverses the matches and releases the
   * customer receipt or supplier payment). Never update `bank_transactions` or
   * `bank_reconciliation_matches` from the client to unblock a reversal.
   */
  const unmatchBankLinesForReversal = async (
    documentType: ReversalDocumentType,
    documentId: string,
    reason: string,
  ): Promise<boolean> => {
    const { error } = await supabase.rpc("resolve_reversal_bank_block" as any, {
      _document_type: documentType,
      _document_id: documentId,
      _reason: reason,
      _actor: user?.id ?? null,
    } as any);
    if (error) {
      console.error("Error un-matching bank lines for reversal:", error);
      toast({
        title: "Could not un-match the bank line",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      return false;
    }
    toast({
      title: "Bank line un-matched",
      description: "The statement line is back for review, so the reversal can continue.",
    });
    return true;
  };





  /**
   * Void an invoice — reverses the linked JE(s) atomically (main + COGS legs),
   * flips the header and restores stock, in one server transaction.
   *
   * Phase 1: voiding is only legal for an UNSETTLED invoice in an open period.
   * The server refuses anything else, and it no longer cascade-voids customer
   * payments. A settled invoice is corrected with a credit note, a refund or a
   * payment reversal — the operations `resolveReversalIntent` names. The old
   * client path here voided the payments AND raised a credit note for the same
   * amount, compensating the customer twice; never reinstate it.
   */
  const voidInvoice = async (options: VoidInvoiceOptions): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }

    try {
      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .select(`*, contact:contacts(id, name)`)
        .eq("id", options.invoiceId)
        .single();

      if (invoiceError) throw invoiceError;
      if (!invoice) throw new Error("Invoice not found");

      const invoiceStatus = invoice.status as InvoiceStatus;
      if (invoiceStatus === "voided" || invoiceStatus === "cancelled") {
        toast({ title: "Already Voided/Cancelled", description: "This invoice has already been voided or cancelled", variant: "destructive" });
        return false;
      }

      const voidDate = options.voidDate || new Date().toISOString().split("T")[0];

      // ADR 0125/0127 + Phase 1: the whole reversal is one server transaction —
      // policy guards, JE reversal (main + COGS), header flip and stock
      // restoration. Never re-split this into client steps: the old sequence
      // could leave the GL reversed while invoices and inventory still counted
      // the sale.
      const { data: voidResult, error: voidErr } = await supabase.rpc("void_invoice_atomic" as any, {
        _invoice_id: options.invoiceId,
        _reason: options.reason,
        _reason_code: options.reasonCode,
        _void_date: voidDate,
        _actor: user.id,
        _client_request_id: options.clientRequestId ?? null,
      } as any);
      if (voidErr) throw voidErr;

      if ((voidResult as any)?.already_voided) {
        toast({ title: "Already Voided", description: "This invoice was already voided." });
        return true;
      }

      logAction({
        action: "voided",
        entityType: "invoice",
        entityId: options.invoiceId,
        entityName: invoice.invoice_number,
        changesSummary: `Invoice voided. Reason: ${options.reason}. Total: ${invoice.total}`,
      });

      toast({ title: "Invoice Voided", description: `Invoice ${invoice.invoice_number} has been voided and GL entries reversed` });
      return true;
    } catch (error: any) {
      console.error("Error voiding invoice:", error);
      toast({ title: "Error Voiding Invoice", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };


  /**
   * Un-reconcile a payment from its current invoice(s).
   *
   * The whole operation lives in `unreconcile_payment_atomic`: JE reversal,
   * payment reset, compensating allocation rows and invoice recompute happen
   * in one transaction. This hook only resolves labels for the audit log and
   * surfaces the result. Do not re-introduce client-side allocation writes —
   * the old path DELETEd allocation rows, which destroys the settlement trail
   * ADR 0027 invariant 5 depends on.
   */
  const unreconcilePayment = async (options: UnreconcilePaymentOptions): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }

    try {
      const { data: payment, error: paymentError } = await supabase
        .from("payments")
        .select("id, receipt_number")
        .eq("id", options.paymentId)
        .single();

      if (paymentError) throw paymentError;
      if (!payment) throw new Error("Payment not found");

      // Labels only — the RPC re-reads allocations under its own lock.
      const allocations = await fetchLiveAllocations(options.paymentId);
      if (allocations.length === 0) {
        toast({ title: "Not Reconciled", description: "This payment is not currently applied to any invoice", variant: "destructive" });
        return false;
      }
      const { data: detachedInvoices } = await supabase
        .from("invoices")
        .select("id, invoice_number")
        .in("id", allocations.map((a) => a.invoice_id));
      const detachedLabel = (detachedInvoices || [])
        .map((i: any) => i.invoice_number)
        .join(", ") || `${allocations.length} invoice(s)`;

      const { error: rpcError } = await supabase.rpc("unreconcile_payment_atomic" as any, {
        _payment_id: options.paymentId,
        _reason: options.reason,
        _actor: user.id,
      } as any);
      if (rpcError) throw rpcError;

      logAction({
        action: "unreconciled",
        entityType: "payment",
        entityId: options.paymentId,
        entityName: (payment as any).receipt_number,
        changesSummary: `Payment unreconciled from invoice(s) ${detachedLabel}. JE reversed. Allocations compensated: ${allocations.length}. Reason: ${options.reason}`,
      });

      toast({ title: "Payment Unreconciled", description: `Payment ${(payment as any).receipt_number} detached and GL reversed.` });
      return true;
    } catch (error: any) {

      console.error("Error unreconciling payment:", error);
      toast({ title: "Error Unreconciling Payment", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };

  /**
   * Re-apply an unreconciled payment to a different invoice (no GL impact).
   */
  const reapplyPayment = async (options: ReapplyPaymentOptions): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }

    try {
      const { data: payment, error: paymentError } = await supabase
        .from("payments")
        .select("*")
        .eq("id", options.paymentId)
        .single();

      if (paymentError) throw paymentError;
      if (!payment) throw new Error("Payment not found");

      // ADR 0027: "already applied" is determined by the presence of live
      // allocations, not by the deprecated single-invoice FK (ADR 0027).
      const existingAllocations = await fetchLiveAllocations(options.paymentId);
      if (existingAllocations.length > 0) {
        toast({ title: "Already Applied", description: "This payment is already applied to an invoice. Unreconcile it first.", variant: "destructive" });
        return false;
      }

      const { data: targetInvoice, error: invoiceError } = await supabase
        .from("invoices")
        .select("*")
        .eq("id", options.newInvoiceId)
        .single();

      if (invoiceError) throw invoiceError;
      if (!targetInvoice) throw new Error("Target invoice not found");

      const targetStatus = targetInvoice.status as InvoiceStatus;
      if (targetStatus === "paid") {
        toast({ title: "Invoice Already Paid", description: "Cannot apply payment to a fully paid invoice", variant: "destructive" });
        return false;
      }
      if (targetStatus === "voided" || targetStatus === "cancelled") {
        toast({ title: "Invoice Voided", description: "Cannot apply payment to a voided invoice", variant: "destructive" });
        return false;
      }

      const paymentAmount = Number((payment as any).amount) || 0;

      // 1. Rebind contact + flip status. Audit fields stay client-side
      //    because reallocate_payment_atomic does not own them.
      const { error: updatePaymentError } = await supabase
        .from("payments")
        .update({
          contact_id: targetInvoice.contact_id,
          status: "applied" as any,
          reapplied_at: new Date().toISOString(),
          reapplied_by: user.id,
          reapply_reason: options.reason,
        } as any)
        .eq("id", options.paymentId);

      if (updatePaymentError) throw updatePaymentError;

      // 2. ADR 0027: route the allocation insert + invoice amount_paid
      //    recompute through the atomic RPC instead of stitching it
      //    client-side. This (a) tags the rows source='reallocation',
      //    (b) recomputes applied/outstanding from the live allocation
      //    sum, (c) writes a payment_reversal_events audit row, and
      //    (d) keeps the sum-invariant trigger from firing mid-flight.
      const { error: reallocErr } = await supabase.rpc("reallocate_payment_atomic" as any, {
        _payment_id: options.paymentId,
        _new_allocations: [
          { invoice_id: options.newInvoiceId, amount: paymentAmount },
        ],
        _reason: options.reason,
        _actor: user.id,
      });
      if (reallocErr) throw reallocErr;

      // 3. AUDIT FIX (B2): post a fresh payment JE with the NEW contact on the
      //    AR line. unreconcilePayment already reversed the original JE.
      const mappings = getInvoiceAccountMappings();
      // The debit side follows the tender the customer actually paid with
      // (cash / bank / M-Pesa / card clearing), not a hardcoded cash account.
      const cashAccountId = getPaymentAccountMappings((payment as any).payment_method)
        .cash_account_id;
      if (mappings.receivable_account_id && cashAccountId) {
        const newJeId = await postPaymentToGL(
          {
            id: (payment as any).id,
            receipt_number: (payment as any).receipt_number,
            payment_date: (payment as any).payment_date,
            amount: paymentAmount,
            invoice_id: options.newInvoiceId,
            contact_id: targetInvoice.contact_id,
          },
          {
            cash_account_id: cashAccountId,
            receivable_account_id: mappings.receivable_account_id,
          }
        );
        if (newJeId) {
          await supabase
            .from("payments")
            .update({ journal_entry_id: newJeId } as any)
            .eq("id", options.paymentId);
        }
      } else {
        console.warn("Re-apply: missing AR/Cash account mappings — skipped GL repost.");
      }

      // Invoice amount_paid + status were recomputed inside
      // reallocate_payment_atomic from the live allocation sum. No
      // additional UPDATE here — double-bookkeeping would race the RPC.

      logAction({
        action: "reapplied",
        entityType: "payment",
        entityId: options.paymentId,
        entityName: (payment as any).receipt_number,
        changesSummary: `Payment re-applied to invoice ${targetInvoice.invoice_number}. Reason: ${options.reason}`,
      });

      toast({ title: "Payment Re-applied", description: `Payment ${(payment as any).receipt_number} has been applied to invoice ${targetInvoice.invoice_number}` });
      return true;
    } catch (error: any) {
      console.error("Error re-applying payment:", error);
      toast({ title: "Error Re-applying Payment", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };

  const getUnreconciledPayments = async () => {
    if (!currentOrg) return [];
    // ADR 0027: an "unreconciled" payment is one with no live allocation
    // rows. Status='unreconciled' is the canonical signal (set by
    // unreconcilePayment); legacy rows that pre-date the allocation table
    // and never received a backfill are also surfaced via the no-allocations
    // fallback.
    const { data, error } = await supabase
      .from("payments")
      .select(`*, contact:contacts(name)`)
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("payment_date", { ascending: false });
    if (error) {
      console.error("Error fetching unreconciled payments:", error);
      return [];
    }
    const candidates = (data || []).filter((p: any) => p.status !== "voided");
    if (candidates.length === 0) return [];

    const { data: allocRows } = await supabase
      .from("payment_allocations")
      .select("payment_id")
      .in(
        "payment_id",
        candidates.map((p: any) => p.id),
      );
    const allocated = new Set((allocRows || []).map((r: any) => r.payment_id));
    return candidates.filter((p: any) => p.status === "unreconciled" || !allocated.has(p.id));
  };

  /**
   * Phase 3 — void a supplier bill.
   *
   * The whole operation belongs to `void_bill_atomic` and runs in one
   * transaction: journal reversal through `void_journal_entry_atomic`, the
   * three-way-match release, the status flip and the void metadata. The bill row
   * is never deleted.
   *
   * This client owns nothing but the reason, the audit label and error
   * surfacing. Do not reintroduce the previous saga (read bill → check
   * payments → reverse JE → update status): each step was its own transaction,
   * so a failure in the middle left the ledger reversed with the bill still
   * open. Settlement, draft and closed-period refusals are the RPC's, so the
   * rules cannot drift between call sites.
   */
  const voidBill = async (options: VoidBillOptions): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }

    try {
      const { data, error } = await supabase.rpc("void_bill_atomic" as any, {
        _bill_id: options.billId,
        _reason: options.reason,
        _reason_code: options.reasonCode,
        _void_date: options.voidDate ?? null,
        _actor: user.id,
        _client_request_id: null,
      } as any);
      if (error) throw error;

      const result = (data ?? {}) as { result?: string; bill_number?: string | null };
      const label = result.bill_number ?? options.billId;

      if (result.result === "already_voided") {
        toast({ title: "Already Voided", description: `Bill ${label} has already been voided.` });
        return true;
      }

      logAction({
        action: "voided",
        entityType: "bill",
        entityId: options.billId,
        entityName: result.bill_number ?? undefined,
        changesSummary: `Bill voided. Reason: ${options.reason}`,
      });

      toast({
        title: "Bill Voided",
        description: `Bill ${label} has been voided and its postings reversed.`,
      });
      return true;
    } catch (error: any) {
      console.error("Error voiding bill:", error);
      toast({ title: "Error Voiding Bill", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };

  /**
   * Phase 4b — reverse a completed goods receipt (the `goods_return` operation
   * `resolve_reversal_intent` advertises for a receipt).
   *
   * `void_goods_receipt_atomic` owns the whole operation in one transaction:
   * GR/NI journal reversal through `void_journal_entry_atomic`, compensating
   * stock movements, purchase-order quantity restoration, warehouse task
   * cancellation, three-way-match release and the status flip. Do not
   * re-implement any leg here — the receipt, its movements and its tasks must
   * move together or not at all.
   */
  const reverseGoodsReceipt = async (options: {
    goodsReceiptId: string;
    reason: string;
    /** Code from `reversal_reason_codes` (ADR 0129) — validated server-side. */
    reasonCode: string;
    voidDate?: string;
  }): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }

    try {
      const { data, error } = await supabase.rpc("void_goods_receipt_atomic" as any, {
        _gr_id: options.goodsReceiptId,
        _reason: options.reason,
        _reason_code: options.reasonCode,
        _void_date: options.voidDate ?? null,
        _actor: user.id,
        _client_request_id: null,
      } as any);
      if (error) throw error;

      const result = (data ?? {}) as { result?: string; receipt_number?: string | null };
      const label = result.receipt_number ?? options.goodsReceiptId;

      if (result.result === "already_reversed") {
        toast({ title: "Already Reversed", description: `Goods receipt ${label} has already been reversed.` });
        return true;
      }

      logAction({
        action: "voided",
        entityType: "goods_receipt",
        entityId: options.goodsReceiptId,
        entityName: result.receipt_number ?? undefined,
        changesSummary: `Goods receipt reversed. Reason: ${options.reason}`,
      });

      toast({
        title: "Goods Returned",
        description: `Goods receipt ${label} was reversed: stock, the purchase order and its postings were all unwound.`,
      });
      return true;
    } catch (error: any) {
      console.error("Error reversing goods receipt:", error);
      toast({
        title: "Error Reversing Goods Receipt",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      return false;
    }
  };

  /**
   * ADR 0132 Phase 4 — reverse a POSTED vendor credit note.
   *
   * `reverse_vendor_credit_note_atomic` owns every leg in one transaction:
   * unwinding live bill applications, voiding the credit-note journal entry
   * through `void_journal_entry_atomic`, and writing the compensating
   * `vendor_credit_movements` rows that give the credit balance back. Never
   * unwind an application or touch a bill balance from the client.
   */
  const reverseVendorCreditNote = async (options: {
    creditNoteId: string;
    reason: string;
    /** Code from `reversal_reason_codes` (ADR 0129) — validated server-side. */
    reasonCode: string;
    reversalDate?: string;
  }): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }

    try {
      const { data, error } = await supabase.rpc("reverse_vendor_credit_note_atomic" as any, {
        _vcn_id: options.creditNoteId,
        _reason: options.reason,
        _reason_code: options.reasonCode,
        _reversal_date: options.reversalDate ?? null,
        _actor: user.id,
        _client_request_id: null,
      } as any);
      if (error) throw error;

      const result = (data ?? {}) as { result?: string; credit_note_number?: string | null };
      const label = result.credit_note_number ?? options.creditNoteId;

      if (result.result === "already_reversed") {
        toast({ title: "Already Reversed", description: `Vendor credit note ${label} has already been reversed.` });
        return true;
      }

      logAction({
        action: "voided",
        entityType: "vendor_credit_note",
        entityId: options.creditNoteId,
        entityName: result.credit_note_number ?? undefined,
        changesSummary: `Vendor credit note reversed (${options.reasonCode}). Reason: ${options.reason}`,
      });

      toast({
        title: "Vendor Credit Note Reversed",
        description: `Credit note ${label} was reversed: its postings, applications and credit balance were all unwound.`,
      });
      return true;
    } catch (error: any) {
      console.error("Error reversing vendor credit note:", error);
      toast({
        title: "Error Reversing Credit Note",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      return false;
    }
  };



  /**
   * ADR 0126 — Void a supplier payment. The whole operation (journal reversal,
   * header void, per-bill recompute from the live allocation sum, audit event)
   * belongs to `void_bill_payment_atomic` and runs in one transaction. The
   * payment row and its allocations are preserved as history; this client owns
   * nothing but the reason, the audit log label and error surfacing.
   */
  const voidBillPayment = async (options: VoidBillPaymentOptions): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }

    try {
      const { data: payment, error: paymentError } = await supabase
        .from("bill_payments")
        .select("id, amount, reference")
        .eq("id", options.billPaymentId)
        .single();

      if (paymentError) throw paymentError;
      if (!payment) throw new Error("Bill payment not found");

      const { data, error } = await supabase.rpc("void_bill_payment_atomic" as any, {
        _bill_payment_id: options.billPaymentId,
        _reason: options.reason,
        _reason_code: options.reasonCode,
        _void_date: options.voidDate ?? null,
        _actor: user.id,
        _client_request_id: options.clientRequestId ?? null,
      } as any);
      if (error) throw error;

      if ((data as any)?.already_voided) {
        toast({ title: "Already Voided", description: "This supplier payment was already voided." });
        return true;
      }

      logAction({
        action: "voided",
        entityType: "bill_payment",
        entityId: options.billPaymentId,
        entityName: payment.reference ?? `BP-${options.billPaymentId.slice(0, 8)}`,
        changesSummary: `Bill payment voided. Reason: ${options.reason}. Amount: ${payment.amount}`,
      });

      toast({ title: "Bill Payment Voided", description: "Bill payment voided and GL entries reversed" });
      return true;
    } catch (error: any) {
      console.error("Error voiding bill payment:", error);
      toast({ title: "Error Voiding Bill Payment", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };


  /**
   * ADR 0012 — Unapply a payment from its invoice, leaving the cash on the
   * customer's deposit balance as an advance. Wraps `unapply_payment_atomic`:
   *   - DR Customer Deposits / CR AR for applied_amount
   *   - Original cash receipt JE is untouched (the money is still in the bank)
   *   - Invoice's amount_paid + status restored
   *   - Payment becomes status='unreconciled' with outstanding=amount, applied=0
   *   - Event row recorded with reason_code
   */
  const unapplyPayment = async (options: UnapplyPaymentOptions): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }
    try {
      const { data, error } = await supabase.rpc("unapply_payment_atomic" as any, {
        _payment_id: options.paymentId,
        _reason_code: options.reasonCode,
        _reason_text: options.reason,
        _reversal_date: options.reversalDate ?? null,
        _client_request_id: options.clientRequestId ?? null,
      } as any);
      if (error) throw error;
      logAction({
        action: "unapplied",
        entityType: "payment",
        entityId: options.paymentId,
        entityName: options.paymentId,
        changesSummary: `Payment unapplied (${options.reasonCode}). Reason: ${options.reason}. Event: ${data}`,
      });
      toast({ title: "Payment Unapplied", description: "Cash returned to customer's deposit balance." });
      return true;
    } catch (error: any) {
      console.error("Error unapplying payment:", error);
      toast({ title: "Error Unapplying Payment", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };

  /**
   * ADR 0012 — Refund a customer out of a chosen bank account.
   * Wraps `refund_customer_atomic`. Drains the customer's deposit balance
   * (when source='payment') or AR (when source='credit_note'), inserts a
   * posted `customer_refunds` row, and posts the cash-out JE.
   */
  const refundCustomer = async (options: RefundCustomerOptions): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }
    try {
      const { data, error } = await supabase.rpc("refund_customer_atomic" as any, {
        _source: options.source,
        _source_id: options.sourceId,
        _bank_account_id: options.bankAccountId,
        _amount: options.amount,
        _refund_date: options.refundDate ?? null,
        _reason_code: options.reasonCode,
        _reason_text: options.reason,
        _payment_method: options.paymentMethod ?? null,
        _reference: options.reference ?? null,
        _client_request_id: options.clientRequestId ?? null,
      } as any);
      if (error) throw error;
      logAction({
        action: "refunded",
        entityType: "customer_refund",
        entityId: options.sourceId,
        entityName: options.sourceId,
        changesSummary: `Customer refunded ${options.amount} from ${options.source} (${options.reasonCode}). Ref: ${data}`,
      });
      toast({ title: "Customer Refunded", description: `Refund of ${options.amount} posted to bank account.` });
      return true;
    } catch (error: any) {
      console.error("Error refunding customer:", error);
      toast({ title: "Error Refunding Customer", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };

  /**
   * ADR 0012 R1 — Convert a payment into a credit-note document.
   * Wraps `issue_credit_note_for_payment_atomic`.
   *   - If the payment is still applied to an invoice, unapplies first
   *     (DR Customer Deposits / CR AR) so cash sits as an advance.
   *   - Inserts a `credit_notes` row with `source_payment_id` set so the
   *     read model does NOT double-count it against the parked cash.
   *   - Idempotent on `client_request_id`.
   */
  const issueCreditNoteForPayment = async (
    options: IssueCreditNoteForPaymentOptions,
  ): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }
    try {
      const { data, error } = await supabase.rpc("issue_credit_note_for_payment_atomic" as any, {
        _payment_id: options.paymentId,
        _reason_text: options.reason,
        _reversal_date: options.reversalDate ?? null,
        _client_request_id: options.clientRequestId ?? null,
      } as any);
      if (error) throw error;
      logAction({
        action: "credit_note_issued",
        entityType: "payment",
        entityId: options.paymentId,
        entityName: options.paymentId,
        changesSummary: `Credit note issued from payment. Reason: ${options.reason}. Event: ${data}`,
      });
      toast({
        title: "Credit Note Issued",
        description: "A credit note document was created the customer can apply to future invoices.",
      });
      return true;
    } catch (error: any) {
      console.error("Error issuing credit note for payment:", error);
      toast({ title: "Error Issuing Credit Note", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };

  /**
   * ADR 0012 R3 — Apply an unapplied customer payment (sitting on Customer
   * Deposits) to a specific invoice. Wraps `apply_customer_deposit_atomic`.
   *   - Posts DR AR / CR Customer Deposits for the clamped amount.
   *   - Updates payment.applied/outstanding and invoice.amount_paid/status.
   *   - Idempotent on `client_request_id`.
   */
  const applyCustomerDeposit = async (
    options: ApplyCustomerDepositOptions,
  ): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }
    try {
      const { data, error } = await supabase.rpc("apply_customer_deposit_atomic" as any, {
        _payment_id: options.paymentId,
        _invoice_id: options.invoiceId,
        _amount: options.amount,
        _apply_date: options.applyDate ?? null,
        _client_request_id: options.clientRequestId ?? null,
      } as any);
      if (error) throw error;
      logAction({
        action: "deposit_applied",
        entityType: "payment",
        entityId: options.paymentId,
        entityName: options.paymentId,
        changesSummary: `Applied ${options.amount} from deposit to invoice ${options.invoiceId}. Event: ${data}`,
      });
      toast({ title: "Deposit Applied", description: "Customer deposit applied to the invoice." });
      return true;
    } catch (error: any) {
      console.error("Error applying customer deposit:", error);
      toast({ title: "Error Applying Deposit", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };

  return {
    resolveReversalIntent,
    previewReversalConsequences,
    unmatchBankLinesForReversal,

    voidPayment,
    voidInvoice,

    voidBill,
    voidBillPayment,
    reverseGoodsReceipt,
    reverseVendorCreditNote,
    // unreconcilePayment intentionally NOT exposed — ADR 0012 Wave R2.
    // The wizard's wrong_invoice_applied → unapplyPayment path is the only
    // supported way to detach a payment. Re-introducing this on the public
    // surface is banned by payment-reversal-intent-contract.test.ts.
    reapplyPayment,
    unapplyPayment,
    refundCustomer,
    issueCreditNoteForPayment,
    applyCustomerDeposit,
    getUnreconciledPayments,
  };
}
