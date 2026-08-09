// Accounting payment hook - type-safe
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { useDefaultAccounts } from "./useDefaultAccounts";
import { usePermissions } from "./usePermissions";
import { useBranch } from "@/contexts/BranchContext";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";
import { deriveInvoiceFromAllocations } from "@/lib/payments/deriveInvoiceFromAllocations";

export interface Payment {
  id: string;
  organization_id: string;
  contact_id: string | null;
  amount: number;
  payment_date: string;
  payment_method: "cash" | "bank_transfer" | "credit_card" | "check" | "other" | "mpesa" | "mobile_money";
  reference: string | null;
  notes: string | null;
  receipt_number: string | null;
  deposit_account_id: string | null;
  created_at: string;
  created_by: string | null;
  /**
   * Derived from `payment_allocations` (ADR 0027 closure — the legacy
   * single-FK column has been dropped). For 1 allocation this is the
   * underlying invoice; for N>1 the `invoice_number` is rendered as
   * "INV-001 +N more". Null when the payment is unapplied (pure
   * customer deposit). Carries `allocation_count` for richer rendering.
   */
  invoice?:
    | { id?: string; invoice_number: string; total?: number; allocation_count?: number }
    | null;
  contact?: { name: string } | null;
}

export function usePayments() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { accounts, isLoading: accountsLoading } = useDefaultAccounts();
  const { can } = usePermissions();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPayments = async () => {
    if (!currentOrg || !currentBusiness) {
      setPayments([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      let query = supabase
        .from("payments")
        .select(`
          *,
          payment_allocations(amount, invoice:invoices(id, invoice_number, total)),
          contact:contacts(name)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("payment_date", { ascending: false });
      query = applyBranchFilter(query, currentBranch?.id ?? null);
      const { data, error } = await query;

      if (error) throw error;
      // ADR 0027: derive the legacy `invoice` shape from allocations so the
      // dozens of downstream consumers (`PaymentListTable`, exports, etc.)
      // keep working without a per-component refactor.
      const projected: Payment[] = ((data as any[]) ?? []).map((row) => ({
        ...row,
        invoice: deriveInvoiceFromAllocations(row.payment_allocations),
      }));
      setPayments(projected);
    } catch (error: any) {
      console.error("Error fetching payments:", error);
      toast({
        title: "Error loading payments",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPayments();
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  // Single-invoice convenience wrapper. Internally delegates to the
  // multi-invoice path so the canonical link is written into
  // payment_allocations only (no single-FK column is populated).
  const recordPayment = async (input: {
    invoice_id: string;
    amount: number;
    payment_date: string;
    payment_method: Payment["payment_method"];
    reference?: string;
    notes?: string;
    deposit_account_id: string;
  }) => {
    if (!can("manageSales")) throw new Error("Permission denied: cannot record payments");
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    // Resolve contact for the invoice — required by the multi-invoice RPC.
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("contact_id")
      .eq("id", input.invoice_id)
      .single();

    if (invoiceError) throw invoiceError;
    if (!invoice?.contact_id) throw new Error("Invoice is missing a customer; cannot record payment.");

    const result = await recordMultiInvoicePayment({
      contact_id: invoice.contact_id,
      allocations: [{ invoice_id: input.invoice_id, amount: input.amount }],
      total_amount: input.amount,
      payment_date: input.payment_date,
      payment_method: input.payment_method,
      reference: input.reference,
      notes: input.notes,
      deposit_account_id: input.deposit_account_id,
    });

    return {
      id: result.id,
      receipt_number: result.receipt_number,
      overpayment_amount: result.excess_amount || 0,
      credit_note_id: result.credit_note_id || null,
    };
  };



  const recordMultiInvoicePayment = async (payment: {
    contact_id: string;
    allocations: Array<{ invoice_id: string; amount: number }>;
    total_amount: number;
    payment_date: string;
    payment_method: Payment["payment_method"];
    reference?: string;
    notes?: string;
    deposit_account_id: string;
    /**
     * Idempotency key. Pass a value that is stable across retries of the SAME
     * logical payment (e.g. a UUID minted when the payment form is opened).
     * Without it, a double-click or network retry records the money twice.
     */
    requestId?: string;
  }) => {

    if (!can("manageSales")) throw new Error("Permission denied: cannot record payments");
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    if (!payment.deposit_account_id) {
      throw new Error("Deposit account is required. Select the GL account that will receive these funds.");
    }

    if (accountsLoading) {
      throw new Error("Default account mappings are still loading. Please retry in a moment.");
    }

    const receivableAccountId = accounts.accounts_receivable_id || null;
    if (!receivableAccountId) {
      throw new Error("Accounts Receivable account is not mapped. Go to Settings > Default Accounts.");
    }

    const customerCreditAccountId = accounts.customer_deposits_id || null;

    const { data: receiptNumberData } = await supabase
      .rpc("get_next_receipt_number", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness.id,
        _branch_id: currentBranch?.id ?? null,
      } as any);

    const receiptNumber = receiptNumberData || `RCP-${Date.now()}`;

    const { data: result, error: rpcError } = await supabase.rpc("record_multi_invoice_payment", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
      _contact_id: payment.contact_id,
      _allocations: payment.allocations as any,
      _total_amount: payment.total_amount,
      _payment_date: payment.payment_date,
      _payment_method: payment.payment_method,
      _reference: payment.reference || null,
      _notes: payment.notes || null,
      _receipt_number: receiptNumber,
      _created_by: user.id,
      _deposit_account_id: payment.deposit_account_id,
      _receivable_account_id: receivableAccountId,
      _customer_credit_account_id: customerCreditAccountId,
      _branch_id: currentBranch?.id ?? null,
      _request_id: payment.requestId ?? null,
    } as any);


    if (rpcError) {
      const msg = rpcError.message || "";
      const isBusinessRule = /belong to different|already paid|outstanding balance|customer credit account|workspace|company|branch|currency|positive allocation|deposit account|Accounts Receivable|no invoices|posted journal entry|closed fiscal period/i.test(msg);

      if (isBusinessRule) {
        throw {
          kind: "validation",
          title: "Payment not recorded",
          message: msg,
          action: "Review the payment details",
          retryable: false,
          cause: rpcError,
        };
      }

      // Preserve the full PostgREST error in developer diagnostics, but do not
      // tell the operator to retry a deterministic database failure.
      console.error("record_multi_invoice_payment failed", rpcError);
      const diagnosticCode = rpcError.code || "SETTLEMENT-RPC";
      throw {
        kind: "unknown",
        title: "Payment not recorded",
        message: `The settlement service rejected this payment. Retrying the same payment will not resolve it. Contact your administrator and provide diagnostic code ${diagnosticCode}.`,
        action: "Contact your administrator",
        retryable: false,
        cause: rpcError,
      };
    }

    const paymentResult = result as any;

    logAction({
      action: "paid",
      entityType: "payment",
      entityId: paymentResult.payment_id,
      entityName: receiptNumber,
      changesSummary: `Multi-invoice payment of ${payment.total_amount} recorded across ${payment.allocations.length} invoices`,
    });

    await fetchPayments();
    return {
      id: paymentResult.payment_id,
      receipt_number: receiptNumber,
      excess_amount: paymentResult.excess_amount || 0,
      credit_note_id: paymentResult.credit_note_id || null,
    };
  };

  const recordAdvancePayment = async (payment: {
    contact_id: string;
    amount: number;
    payment_date: string;
    payment_method: Payment["payment_method"];
    reference?: string;
    notes?: string;
    deposit_account_id: string;
  }) => {
    if (!can("manageSales")) throw new Error("Permission denied: cannot record payments");
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    if (!payment.deposit_account_id) {
      throw new Error("Deposit account is required for advance payment.");
    }

    if (accountsLoading) {
      throw new Error("Default account mappings are still loading. Please retry in a moment.");
    }

    const { data: receiptNumberData } = await supabase
      .rpc("get_next_receipt_number", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness.id,
        _branch_id: currentBranch?.id ?? null,
      } as any);

    const receiptNumber = receiptNumberData || `RCP-${Date.now()}`;

    const advanceLiabilityAccountId = accounts.customer_deposits_id || null;

    const { data: result, error: rpcError } = await supabase.rpc("record_advance_payment", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness.id,
      _contact_id: payment.contact_id,
      _amount: payment.amount,
      _payment_date: payment.payment_date,
      _payment_method: payment.payment_method,
      _reference: payment.reference || null,
      _notes: payment.notes || null,
      _receipt_number: receiptNumber,
      _created_by: user.id,
      _deposit_account_id: payment.deposit_account_id,
      _advance_liability_account_id: advanceLiabilityAccountId,
      _branch_id: currentBranch?.id ?? null,
    } as any);

    if (rpcError) throw rpcError;

    const advResult = result as any;

    logAction({
      action: "created",
      entityType: "payment",
      entityId: advResult.payment_id,
      entityName: receiptNumber,
      changesSummary: `Advance payment of ${payment.amount} recorded`,
    });

    await fetchPayments();
    return {
      id: advResult.payment_id,
      receipt_number: receiptNumber,
      credit_note_id: advResult.credit_note_id,
      credit_note_number: advResult.credit_note_number,
    };
  };

  // Resolve payments linked to an invoice via the allocation ledger.
  // payment_allocations is the canonical link (ADR 0027). Each allocated
  // payment is returned once, with the allocation amount projected onto
  // Payment.amount for display purposes.
  const getPaymentsForInvoice = async (invoiceId: string): Promise<Payment[]> => {
    const { data, error } = await supabase
      .from("payment_allocations")
      .select(`
        amount,
        payment:payments(
          *,
          contact:contacts(name)
        )
      `)
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const rows = (data ?? []) as Array<{ amount: number; payment: any }>;
    return rows
      .filter((r) => r.payment)
      .map((r) => ({
        ...(r.payment as Payment),
        amount: Number(r.amount),
        invoice: null,
      }))
      .sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1));
  };


  return {
    payments,
    isLoading,
    recordPayment,
    recordMultiInvoicePayment,
    recordAdvancePayment,
    getPaymentsForInvoice,
    refreshPayments: fetchPayments,
  };
}
