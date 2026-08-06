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

export interface VoidInvoiceOptions {
  invoiceId: string;
  reason: string;
  voidDate?: string;
  createCreditNote?: boolean;
}

export interface VoidBillOptions {
  billId: string;
  reason: string;
  voidDate?: string;
}

export interface VoidBillPaymentOptions {
  billPaymentId: string;
  reason: string;
  voidDate?: string;
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

/**
 * Subtract `delta` from invoices.amount_paid and re-derive status without
 * reopening voided/cancelled invoices.
 */
async function decrementInvoicePaid(invoiceId: string, delta: number): Promise<void> {
  if (delta <= 0) return;
  const { data: inv, error: readErr } = await supabase
    .from("invoices")
    .select("total, amount_paid, status")
    .eq("id", invoiceId)
    .single();
  if (readErr) throw readErr;
  if (!inv) return;

  const total = Number((inv as any).total) || 0;
  const currentPaid = Number((inv as any).amount_paid) || 0;
  const currentStatus = (inv as any).status as string;
  const newPaid = Math.max(0, currentPaid - delta);

  let newStatus: "sent" | "partial" | "paid" | undefined;
  if (currentStatus !== "voided" && currentStatus !== "cancelled") {
    if (newPaid <= 0) newStatus = "sent";
    else if (newPaid < total) newStatus = "partial";
    else newStatus = "paid";
  }

  const update: Record<string, unknown> = { amount_paid: newPaid };
  if (newStatus) update.status = newStatus;

  const { error: updErr } = await supabase
    .from("invoices")
    .update(update as any)
    .eq("id", invoiceId);
  if (updErr) throw updErr;
}

export function useTransactionReversal() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { postCreditNoteToGL, postPaymentToGL } = useGLPosting();
  const { getInvoiceAccountMappings, accounts } = useDefaultAccounts();

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
   * Void an invoice — reverses linked JE(s) atomically (main + COGS), updates status,
   * voids active payments, optionally creates a credit note, and restores stock.
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

      // ADR 0027: discover payments that touched this invoice via the
      // allocation ledger, not the deprecated single-invoice FK (ADR 0027).
      const { data: allocRows, error: allocErr } = await supabase
        .from("payment_allocations")
        .select("payment_id, amount, payments!inner(id, status, amount, receipt_number, journal_entry_id)")
        .eq("invoice_id", options.invoiceId);
      if (allocErr) throw allocErr;

      const paymentMap = new Map<string, any>();
      for (const row of (allocRows || []) as any[]) {
        const p = row.payments;
        if (!p || p.status === "voided") continue;
        if (!paymentMap.has(p.id)) paymentMap.set(p.id, p);
      }
      const activePayments = Array.from(paymentMap.values());
      const hasActivePayments = activePayments.length > 0;
      const totalPayments = activePayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

      if (hasActivePayments && !options.createCreditNote) {
        toast({
          title: "Has Active Payments",
          description: `This invoice has ${activePayments.length} payment(s) totaling ${totalPayments}. Void payments first or enable credit note creation.`,
          variant: "destructive",
        });
        return false;
      }

      const voidDate = options.voidDate || new Date().toISOString().split("T")[0];

      // AUDIT FIX (G2): derive business_id from the INVOICE row, not UI context.
      // Voiding from HQ (no business selected) or after switching companies must
      // still match the JE that belongs to this invoice.
      const invoiceBusinessId = (invoice as any).business_id as string | null;

      // 1. Reverse main invoice JE (if linked) — canonical RPC handles everything.
      const invoiceJeId = (invoice as any).journal_entry_id;
      let mainReversalJeId: string | null = null;
      if (invoiceJeId) {
        mainReversalJeId = await reverseJEAtomic(invoiceJeId, `Void invoice ${invoice.invoice_number}: ${options.reason}`, user.id, voidDate);
      } else {
        // Fallback: look up by source linkage (no subtype = main) using the
        // invoice's own business_id, NOT the UI-active business.
        let mainQ = supabase
          .from("journal_entries")
          .select("id, source_subtype")
          .eq("organization_id", currentOrg.id)
          .eq("source_type", "invoice")
          .eq("source_id", options.invoiceId)
          .neq("status", "voided")
          .neq("status", "reversed");
        if (invoiceBusinessId) mainQ = mainQ.eq("business_id", invoiceBusinessId);
        const { data: mainJE } = await mainQ;
        const main = (mainJE || []).find(je => (je.source_subtype || "main") === "main");
        if (main?.id) {
          mainReversalJeId = await reverseJEAtomic(main.id, `Void invoice ${invoice.invoice_number}: ${options.reason}`, user.id, voidDate);
        }
      }

      // 2. Reverse COGS sub-entry — keyed off the invoice's business_id.
      let cogsQ = supabase
        .from("journal_entries")
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("source_type", "invoice")
        .eq("source_id", options.invoiceId)
        .eq("source_subtype", "cogs")
        .neq("status", "voided")
        .neq("status", "reversed");
      if (invoiceBusinessId) cogsQ = cogsQ.eq("business_id", invoiceBusinessId);
      const { data: cogsJEs } = await cogsQ;
      for (const cogsJE of cogsJEs || []) {
        await reverseJEAtomic(cogsJE.id, `Void COGS for invoice ${invoice.invoice_number}: ${options.reason}`, user.id, voidDate);
      }

      // 2b. Defensive verification — assert every reversed original now has a real
      //     reversal sub-entry pointing at it.
      let verifyQ = supabase
        .from("journal_entries")
        .select("id, entry_number, source_subtype, status, reversed_by_id")
        .eq("organization_id", currentOrg.id)
        .eq("source_type", "invoice")
        .eq("source_id", options.invoiceId);
      if (invoiceBusinessId) verifyQ = verifyQ.eq("business_id", invoiceBusinessId);
      const { data: allInvoiceJEs } = await verifyQ;
      for (const je of allInvoiceJEs || []) {
        if (je.status !== "reversed" || !je.reversed_by_id) continue;
        const expectedSubtype =
          !je.source_subtype || je.source_subtype === "" ? "reversal" : `reversal:${je.source_subtype}`;
        const { data: rev } = await supabase
          .from("journal_entries")
          .select("source_subtype, reversal_of_id")
          .eq("id", je.reversed_by_id)
          .maybeSingle();
        if (!rev || rev.reversal_of_id !== je.id || rev.source_subtype !== expectedSubtype) {
          throw new Error(
            `Reversal integrity check failed for ${je.entry_number}: expected reversal sub-entry with subtype '${expectedSubtype}' linked back to this entry, found ${JSON.stringify(rev)}`,
          );
        }
      }

      // 3. GL succeeded → update invoice status. AUDIT FIX (G4): null out
      //    journal_entry_id (forward link) and stamp reversal_journal_entry_id
      //    so reports filtering "voided invoices with active JE" stay honest.
      const { error: updateInvoiceError } = await supabase
        .from("invoices")
        .update({
          status: "voided" as any,
          voided_at: new Date().toISOString(),
          voided_by: user.id,
          void_reason: options.reason,
          journal_entry_id: null,
          reversal_journal_entry_id: mainReversalJeId,
        } as any)
        .eq("id", options.invoiceId);

      if (updateInvoiceError) throw updateInvoiceError;

      // 4. Void all active payments and reverse their GL entries
      if (hasActivePayments && options.createCreditNote) {
        for (const payment of activePayments) {
          const paymentJeId = (payment as any).journal_entry_id;
          if (paymentJeId) {
            await reverseJEAtomic(paymentJeId, `Auto-void payment ${payment.receipt_number}: parent invoice voided`, user.id, voidDate);
          }
          await supabase.from("payments").update({
            status: "voided" as any,
            voided_at: new Date().toISOString(),
            voided_by: user.id,
            void_reason: `Auto-voided: parent invoice ${invoice.invoice_number} voided`,
          } as any).eq("id", payment.id);
        }

        // 5. Create credit note for paid amount
        const { data: cnNumber } = await supabase.rpc("get_next_credit_note_number", { _org_id: currentOrg.id });
        const creditNoteNumber = cnNumber || `CN-${Date.now()}`;

        const { data: creditNote, error: cnError } = await supabase
          .from("credit_notes")
          .insert({
            credit_note_number: creditNoteNumber,
            organization_id: currentOrg.id,
            business_id: invoiceBusinessId,
            contact_id: invoice.contact_id,
            invoice_id: options.invoiceId,
            total: totalPayments,
            subtotal: totalPayments,
            tax_amount: 0,
            reason: `Void of invoice ${invoice.invoice_number}: ${options.reason}`,
            status: "issued",
            issue_date: voidDate,
            created_by: user.id,
            currency: invoice.currency || "KES",
          } as any)
          .select()
          .single();

        if (cnError) {
          console.error("Error creating credit note:", cnError);
        } else if (creditNote) {
          const invoiceAccountMappings = getInvoiceAccountMappings();
          if (invoiceAccountMappings.receivable_account_id && invoiceAccountMappings.revenue_account_id) {
            await postCreditNoteToGL({
              id: creditNote.id,
              credit_note_number: creditNoteNumber,
              issue_date: voidDate,
              subtotal: totalPayments,
              tax_amount: 0,
              total: totalPayments,
              invoice_number: invoice.invoice_number,
              is_fully_paid: invoiceStatus === "paid",
            }, {
              receivable_account_id: invoiceAccountMappings.receivable_account_id,
              revenue_account_id: invoiceAccountMappings.revenue_account_id,
              tax_liability_account_id: invoiceAccountMappings.tax_liability_account_id || undefined,
              customer_deposits_account_id: accounts.customer_deposits_id || undefined,
            });
          }

          logAction({
            action: "created",
            entityType: "credit_note",
            entityId: creditNote.id,
            entityName: `CN for ${invoice.invoice_number}`,
            changesSummary: `Credit note created for voided invoice. Amount: ${totalPayments}`,
          });
        }
      }

      // 6. Restore stock atomically via RPC (G3 fix). Idempotent: a second void
      //    attempt is a no-op. Mirrors original warehouse_id + branch_id.
      const { error: stockErr } = await supabase.rpc("restore_invoice_stock_atomic", {
        p_invoice_id: options.invoiceId,
        p_user_id: user.id,
        p_reason: options.reason,
      } as any);
      if (stockErr) {
        // Stock restoration failure must NOT silently leave inventory wrong.
        console.error("restore_invoice_stock_atomic failed:", stockErr);
        throw new Error(`Stock restoration failed: ${stockErr.message}`);
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
      const cashAccountId = (accounts as any).cash_account_id || (accounts as any).bank_account_id;
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
   * Void a bill — reverses the linked JE atomically and updates bill status.
   */
  const voidBill = async (options: VoidBillOptions): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }

    try {
      const { data: bill, error: billError } = await supabase
        .from("bills")
        .select("*")
        .eq("id", options.billId)
        .single();

      if (billError) throw billError;
      if (!bill) throw new Error("Bill not found");

      if (bill.status === "void") {
        toast({ title: "Already Voided", description: "This bill has already been voided", variant: "destructive" });
        return false;
      }

      // Allocation-aware (ADR 0028): bill_payments no longer has bill_id;
      // detect attached payments through bill_payment_allocations.
      const { data: payments } = await supabase
        .from("bill_payment_allocations")
        .select("id")
        .eq("bill_id", options.billId);

      if (payments && payments.length > 0) {
        toast({
          title: "Has Active Payments",
          description: `This bill has ${payments.length} payment(s). Void payments first before voiding the bill.`,
          variant: "destructive",
        });
        return false;
      }

      const voidDate = options.voidDate || new Date().toISOString().split("T")[0];

      const billJeId = (bill as any).journal_entry_id;
      if (billJeId) {
        await reverseJEAtomic(billJeId, `Void bill ${bill.bill_number}: ${options.reason}`, user.id, voidDate);
      } else {
        const { data: orphanJE } = await supabase
          .from("journal_entries")
          .select("id")
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .eq("source_type", "bill")
          .eq("source_id", options.billId)
          .neq("status", "voided")
          .neq("status", "reversed")
          .maybeSingle();
        if (orphanJE?.id) {
          await reverseJEAtomic(orphanJE.id, `Void bill ${bill.bill_number}: ${options.reason}`, user.id, voidDate);
        }
      }

      const { error: updateError } = await supabase
        .from("bills")
        .update({ status: "void" as any })
        .eq("id", options.billId);

      if (updateError) throw updateError;

      logAction({
        action: "voided",
        entityType: "bill",
        entityId: options.billId,
        entityName: bill.bill_number,
        changesSummary: `Bill voided. Reason: ${options.reason}. Total: ${bill.total}`,
      });

      toast({ title: "Bill Voided", description: `Bill ${bill.bill_number} has been voided and GL entries reversed` });
      return true;
    } catch (error: any) {
      console.error("Error voiding bill:", error);
      toast({ title: "Error Voiding Bill", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
  };

  /**
   * Void a bill payment — reverses linked JE atomically, deletes record, restores bill balance.
   */
  const voidBillPayment = async (options: VoidBillPaymentOptions): Promise<boolean> => {
    if (!currentOrg || !user) {
      toast({ title: "Error", description: "Organization or user not available", variant: "destructive" });
      return false;
    }

    try {
      const { data: payment, error: paymentError } = await supabase
        .from("bill_payments")
        .select("*")
        .eq("id", options.billPaymentId)
        .single();

      if (paymentError) throw paymentError;
      if (!payment) throw new Error("Bill payment not found");

      // Allocation-aware (ADR 0028): a payment can settle many bills.
      const { data: allocations, error: allocError } = await supabase
        .from("bill_payment_allocations")
        .select("bill_id, amount, bill:bills(id, bill_number, total, amount_paid)")
        .eq("bill_payment_id", options.billPaymentId);
      if (allocError) throw allocError;

      const allocList = (allocations || []) as Array<{
        bill_id: string;
        amount: number;
        bill: { id: string; bill_number: string; total: number; amount_paid: number } | null;
      }>;

      const voidDate = options.voidDate || new Date().toISOString().split("T")[0];
      const billLabel = allocList.length === 1
        ? (allocList[0].bill?.bill_number ?? "unknown")
        : `${allocList.length} bills`;

      const bpJeId = (payment as any).journal_entry_id;
      if (bpJeId) {
        await reverseJEAtomic(bpJeId, `Void bill payment for ${billLabel}: ${options.reason}`, user.id, voidDate);
      } else {
        const { data: orphanJE } = await supabase
          .from("journal_entries")
          .select("id")
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .eq("source_type", "bill_payment")
          .eq("source_id", options.billPaymentId)
          .neq("status", "voided")
          .neq("status", "reversed")
          .maybeSingle();
        if (orphanJE?.id) {
          await reverseJEAtomic(orphanJE.id, `Void bill payment for ${billLabel}: ${options.reason}`, user.id, voidDate);
        }
      }

      // Restore each bill's amount_paid by its specific allocated share.
      for (const alloc of allocList) {
        if (!alloc.bill) continue;
        const newAmountPaid = Math.max(0, (alloc.bill.amount_paid || 0) - alloc.amount);
        const newStatus = newAmountPaid <= 0 ? "received" : "partial";
        await supabase
          .from("bills")
          .update({ amount_paid: newAmountPaid, status: newStatus })
          .eq("id", alloc.bill.id);
      }

      // Allocations CASCADE on bill_payments delete.
      const { error: deleteError } = await supabase
        .from("bill_payments")
        .delete()
        .eq("id", options.billPaymentId);

      if (deleteError) throw deleteError;

      logAction({
        action: "voided",
        entityType: "bill_payment",
        entityId: options.billPaymentId,
        entityName: `BP-${billLabel}`,
        changesSummary: `Bill payment voided. Reason: ${options.reason}. Amount: ${payment.amount}`,
      });

      toast({ title: "Bill Payment Voided", description: `Bill payment has been voided and GL entries reversed` });
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
    voidPayment,
    voidInvoice,
    voidBill,
    voidBillPayment,
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
