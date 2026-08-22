import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useFiscalPeriods } from "./useFiscalPeriods";
import { usePermissions } from "./usePermissions";

export interface GLEntry {
  account_id: string;
  debit_amount: number;
  credit_amount: number;
  description?: string;
  contact_id?: string;
  /** Optional: analytic account for cost/profit center tracking */
  analytic_account_id?: string;
  /** Optional: per-line exchange rate override */
  exchange_rate?: number;
}

/**
 * SOURCE TYPE TAXONOMY (must stay in sync with v_je_source_consistency view in DB).
 *
 * RULE: Each business event has exactly ONE canonical source_type.
 * Two writers must NEVER post for the same event under different source_type strings,
 * because the uniq_je_per_source DB index keys on source_type and would not catch it.
 *
 * Aliases / common confusions to AVOID:
 *   - delivery note posting → use "delivery"  (NOT "delivery_note")
 *   - vendor credit note posting → use "vendor_credit_note"
 *   - sales return → use "sales_return"
 *   - purchase return → use "purchase_return"
 *   - reversal/void of any of the above → keep the ORIGINAL source_type and source_id,
 *     and set source_subtype: "reversal" so the unique index detects double-voids.
 */
export interface GLPostingOptions {
  source_type: "invoice" | "bill" | "payment" | "bill_payment" | "expense" | "pos_sale" | "pos_shift" | "payroll" | "manual" | "credit_note" | "vendor_credit_note" | "bank_recon" | "year_end_closing" | "purchase_return" | "sales_return" | "migration" | "stock_adjustment" | "asset_acquisition" | "asset_disposal" | "depreciation" | "opening_balance" | "owner_investment" | "owner_drawing" | "bank_transfer" | "loan_received" | "loan_payment" | "delivery" | "scrap" | "physical_count" | "reversal";
  /** MUST be a real UUID. Never compose strings like `cogs-${id}` — use source_subtype instead. */
  source_id: string;
  /**
   * Distinguishes sub-entries that share the same source document.
   * Example: an invoice's main JE has subtype 'main' (default), its COGS JE has subtype 'cogs'.
   * NULL/omitted is treated as 'main' by the unique index.
   */
  source_subtype?: "main" | "cogs" | "wht" | "writeoff" | "service_charge" | "interest" | "reversal" | "refund" | "cash_diff" | string;
  reference: string;
  memo?: string;
  entry_date: string;
  entries: GLEntry[];
  is_closing?: boolean;
  is_adjusting?: boolean;
  /** Optional: foreign currency code for multi-currency postings */
  currency?: string;
  /** Optional: exchange rate used for conversion */
  exchange_rate?: number;
  /**
   * Optional: branch dimension for per-branch P&L / sales reports.
   * If omitted, the active branch from BranchContext is stamped automatically.
   * Pass `null` explicitly to record an unattributable JE (e.g. HQ-level
   * depreciation that does not belong to any branch).
   */
  branch_id?: string | null;
}

/**
 * Hook for posting transactions to the General Ledger
 * 
 * Enterprise features:
 * - Atomic DB transactions via RPC (no orphan headers)
 * - Fiscal period lock enforcement
 * - Idempotency checks
 * - Permission guards
 * - Multi-currency support
 */
export function useGLPosting() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { isDateLocked } = useFiscalPeriods();
  const { can } = usePermissions();

  // Numbering belongs to the posting engine (post_journal_entry_atomic →
  // generate_next_je_number). The client passes null and never mints a number.
  const getNextJournalNumber = async (): Promise<null> => null;

  /**
   * Post a transaction to the General Ledger using atomic RPC.
   * All validation (balance, period lock, permissions, idempotency) is performed
   * before the single atomic DB call.
   */
  const postToGL = async (options: GLPostingOptions): Promise<string | null> => {
    if (!currentOrg || !user) {
      toast({ title: "Cannot post to GL", description: "Organization or user not available", variant: "destructive" });
      return null;
    }

    // Permission guard
    if (!can("manageFinancials")) {
      toast({ title: "Permission denied", description: "You don't have permission to post to the General Ledger.", variant: "destructive" });
      return null;
    }

    // Fiscal period lock check
    if (isDateLocked(options.entry_date)) {
      toast({ title: "Fiscal Period Locked", description: `Cannot post to GL: the fiscal period for ${options.entry_date} is closed and locked.`, variant: "destructive" });
      return null;
    }

    // Validate debits equal credits
    const totalDebits = options.entries.reduce((sum, e) => sum + e.debit_amount, 0);
    const totalCredits = options.entries.reduce((sum, e) => sum + e.credit_amount, 0);

    if (Math.abs(totalDebits - totalCredits) > 0.001) {
      toast({ title: "GL Posting Error", description: `Debits (${totalDebits}) must equal Credits (${totalCredits})`, variant: "destructive" });
      return null;
    }

    // Fix 3: Guard against same-account wash entries
    // A journal entry where all debit and credit lines reference the same account is invalid
    const debitAccountIds = new Set(options.entries.filter(e => e.debit_amount > 0).map(e => e.account_id));
    const creditAccountIds = new Set(options.entries.filter(e => e.credit_amount > 0).map(e => e.account_id));
    if (debitAccountIds.size === 1 && creditAccountIds.size === 1) {
      const [debitAcct] = debitAccountIds;
      const [creditAcct] = creditAccountIds;
      if (debitAcct === creditAcct) {
        const errMsg = `GL Posting rejected: debit and credit lines both reference the same account (${debitAcct}). This wash entry has no financial effect.`;
        console.error(errMsg);
        toast({ title: "GL Posting Error", description: "Cannot post: debit and credit accounts are identical (wash entry).", variant: "destructive" });
        throw new Error(errMsg);
      }
    }

    // Validate no empty account IDs — provide specific diagnostics
    for (const entry of options.entries) {
      if (!entry.account_id) {
        const lineDesc = entry.description || "Unknown";
        const errMsg = `GL Posting rejected: missing account_id for line "${lineDesc}" in ${options.source_type} (ref: ${options.reference}). Configure the relevant default account mapping in Settings > Finance > Default Accounts.`;
        console.error(errMsg);
        toast({ title: "Missing Account Mapping", description: `No GL account configured for: "${lineDesc}". Go to Settings > Default Accounts to fix.`, variant: "destructive" });
        throw new Error(errMsg);
      }
    }

    // Phase 3: Cross-business account validation guard
    if (currentBusiness?.id) {
      const accountIds = [...new Set(options.entries.map(e => e.account_id))];
      const { data: accountRows } = await supabase
        .from("accounts")
        .select("id, business_id, name")
        .in("id", accountIds);

      if (accountRows) {
        const foreignAccounts = accountRows.filter(
          a => a.business_id && a.business_id !== currentBusiness.id
        );
        if (foreignAccounts.length > 0) {
          const names = foreignAccounts.map(a => a.name).join(", ");
          const errMsg = `GL Posting rejected: accounts belong to a different business: ${names}. Check default account mappings in Settings.`;
          console.error(errMsg);
          toast({ title: "Cross-Business Error", description: "Some GL accounts belong to a different business. Please reconfigure default accounts.", variant: "destructive" });
          throw new Error(errMsg);
        }
      }
    }

    // Validate source_id is a real UUID (the DB column is uuid; passing strings like
    // `cogs-${invoice.id}` will fail with a useless error). Use source_subtype for sub-entries.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (options.source_type !== "manual" && options.source_id && !UUID_RE.test(options.source_id)) {
      const errMsg = `GL Posting rejected: source_id "${options.source_id}" is not a valid UUID. Use a real document UUID and pass source_subtype to distinguish sub-entries.`;
      console.error(errMsg);
      toast({ title: "GL Posting Error", description: "Invalid source document reference (not a UUID).", variant: "destructive" });
      throw new Error(errMsg);
    }

    try {
      // Idempotency check (matches DB unique index: org + source_type + source_id + COALESCE(source_subtype,'main'))
      if (options.source_type !== "manual" && options.source_id) {
        const subtype = options.source_subtype || "main";
        const { data: existing } = await supabase
          .from("journal_entries")
          .select("id, source_subtype")
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .eq("source_type", options.source_type)
          .eq("source_id", options.source_id)
          .neq("status", "voided");

        const match = (existing || []).find(
          (e: any) => (e.source_subtype || "main") === subtype
        );
        if (match) {
          console.warn(`GL posting skipped: JE already exists for ${options.source_type}/${options.source_id}/${subtype} → ${match.id}`);
          return match.id;
        }
      }

      const entryNumber = await getNextJournalNumber();
      const description = options.memo || `Auto-posted from ${options.source_type}`;

      // Budget enforcement: warn if any debit-side accounts would exceed the
      // active budget for THIS business/branch. Scope is mandatory — the RPC
      // authorizes the caller against it and refuses cross-business reads.
      const expenseEntries = options.entries.filter(e => e.debit_amount > 0);
      const budgetCheckBranchId =
        options.branch_id !== undefined ? options.branch_id : (currentBranch?.id ?? null);
      if (
        expenseEntries.length > 0 &&
        consumesBudget(options.source_type) &&
        currentBusiness?.id
      ) {

        try {
          const accountIds = expenseEntries.map(e => e.account_id);
          const amounts = expenseEntries.map(e => e.debit_amount);
          const { data: budgetWarnings } = await supabase.rpc("check_budget_variance", {
            _org_id: currentOrg.id,
            _business_id: currentBusiness.id,
            _branch_id: budgetCheckBranchId ?? undefined,
            _account_ids: accountIds,
            _amounts: amounts,
            _entry_date: options.entry_date,
          });

          if (budgetWarnings && Array.isArray(budgetWarnings) && budgetWarnings.length > 0) {
            const warnings = budgetWarnings.map((w: any) =>
              `${w.account_name}: budget ${w.budgeted}, projected ${w.projected_total}`
            ).join("; ");
            console.warn(`Budget exceeded: ${warnings}`);
            toast({ title: "Budget Warning", description: `Posting will exceed budget: ${warnings}`, variant: "destructive" });
            // Warning only — does not block posting. Override with options.skipBudgetCheck in future.
          }
        } catch (budgetErr) {
          console.warn("Budget check failed (non-blocking):", budgetErr);
        }
      }

      // Build lines JSONB for the atomic RPC (with analytic + currency support)
      const linesJson = options.entries.map((entry) => ({
        account_id: entry.account_id,
        debit: entry.debit_amount,
        credit: entry.credit_amount,
        description: entry.description || description,
        contact_id: entry.contact_id || null,
        analytic_account_id: entry.analytic_account_id || null,
        exchange_rate: entry.exchange_rate || null,
      }));

      // Single atomic DB call — header + lines in one transaction
      const { data: jeId, error: rpcError } = await supabase.rpc("post_journal_entry_atomic", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness?.id || null,
        _entry_number: entryNumber,
        _entry_date: options.entry_date,
        _reference: options.reference,
        _description: description,
        _source_type: options.source_type,
        _source_id: options.source_id,
        _created_by: user.id,
        _is_closing: options.is_closing || false,
        _is_adjusting: options.is_adjusting || false,
        _lines: linesJson,
        _currency: options.currency || null,
        _exchange_rate: options.exchange_rate || null,
        _source_subtype: options.source_subtype || null,
        // Stage 3: stamp branch dimension. Caller may override via options;
        // default is the active branch in context (NULL = unassigned).
        _branch_id: options.branch_id !== undefined ? options.branch_id : (currentBranch?.id ?? null),
      } as any);

      if (rpcError) {
        // Surface the real DB error instead of swallowing it. Callers (e.g. invoice
        // confirmation) rely on this to roll back state on failure.
        console.error("GL Posting RPC error:", rpcError);
        toast({ title: "GL Posting Failed", description: rpcError.message, variant: "destructive" });
        throw rpcError;
      }

      if (!jeId) {
        const errMsg = "GL Posting failed: RPC returned no journal entry ID.";
        console.error(errMsg);
        toast({ title: "GL Posting Failed", description: errMsg, variant: "destructive" });
        throw new Error(errMsg);
      }

      return jeId as string;
    } catch (error: any) {
      console.error("GL Posting error:", error);
      // Surface the real error so callers can react. Toast was already raised above
      // for RPC errors; re-raising avoids double-toasting for those cases.
      throw error;
    }
  };

  // getDefaultAccounts removed: legacy gl_transaction_mappings table dropped in
  // Settings Architecture Cleanup. All GL routing flows through default_account_settings.

  // postInvoiceToGL was removed in C-5b. All invoice posting now flows through
  // confirmInvoiceAndPostGL → postToGL with per-line revenue grouping + COGS.

  const postBillToGL = async (bill: {
    id: string;
    bill_number: string;
    bill_date: string;
    subtotal: number;
    tax_amount: number;
    total: number;
    vendor_id?: string;
  }, accountMappings: {
    payable_account_id: string;
    expense_account_id: string;
    tax_asset_account_id?: string;
  }) => {
    const entries: GLEntry[] = [
      { account_id: accountMappings.expense_account_id, debit_amount: bill.subtotal, credit_amount: 0, description: `Bill ${bill.bill_number} - Expense` },
      { account_id: accountMappings.payable_account_id, debit_amount: 0, credit_amount: bill.total, description: `Bill ${bill.bill_number} - Accounts Payable`, contact_id: bill.vendor_id },
    ];

    if (bill.tax_amount > 0 && accountMappings.tax_asset_account_id) {
      entries.push({ account_id: accountMappings.tax_asset_account_id, debit_amount: bill.tax_amount, credit_amount: 0, description: `Bill ${bill.bill_number} - Input Tax` });
    }

    return postToGL({ source_type: "bill", source_id: bill.id, reference: bill.bill_number, memo: `Bill ${bill.bill_number} confirmed`, entry_date: bill.bill_date, entries });
  };

  const postPaymentToGL = async (payment: {
    id: string;
    receipt_number: string;
    payment_date: string;
    amount: number;
    invoice_id?: string;
    contact_id?: string;
  }, accountMappings: {
    cash_account_id: string;
    receivable_account_id: string;
  }) => {
    return postToGL({
      source_type: "payment",
      source_id: payment.id,
      reference: payment.receipt_number,
      memo: `Payment received - ${payment.receipt_number}`,
      entry_date: payment.payment_date,
      entries: [
        { account_id: accountMappings.cash_account_id, debit_amount: payment.amount, credit_amount: 0, description: `Payment ${payment.receipt_number} - Cash Receipt` },
        { account_id: accountMappings.receivable_account_id, debit_amount: 0, credit_amount: payment.amount, description: `Payment ${payment.receipt_number} - AR Reduction`, contact_id: payment.contact_id },
      ],
    });
  };

  const postExpenseToGL = async (expense: {
    id: string;
    expense_date: string;
    amount: number;
    category?: string;
    reference?: string;
  }, accountMappings: {
    expense_account_id: string;
    payment_account_id: string;
  }) => {
    return postToGL({
      source_type: "expense",
      source_id: expense.id,
      reference: expense.reference || `EXP-${expense.id.slice(0, 8)}`,
      memo: `Expense: ${expense.category || "General"}`,
      entry_date: expense.expense_date,
      entries: [
        { account_id: accountMappings.expense_account_id, debit_amount: expense.amount, credit_amount: 0, description: `Expense - ${expense.category || "General"}` },
        { account_id: accountMappings.payment_account_id, debit_amount: 0, credit_amount: expense.amount, description: `Expense payment` },
      ],
    });
  };

  const postCreditNoteToGL = async (creditNote: {
    id: string;
    credit_note_number: string;
    issue_date: string;
    subtotal: number;
    tax_amount: number;
    total: number;
    invoice_number?: string;
    is_fully_paid?: boolean;
    contact_id?: string;
  }, accountMappings: {
    receivable_account_id: string;
    revenue_account_id: string;
    tax_liability_account_id?: string;
    customer_deposits_account_id?: string;
  }) => {
    // Determine the credit-side account based on invoice payment status
    const useCustomerDeposits = creditNote.is_fully_paid && accountMappings.customer_deposits_account_id;
    const creditAccountId = useCustomerDeposits
      ? accountMappings.customer_deposits_account_id!
      : accountMappings.receivable_account_id;
    const creditDescription = useCustomerDeposits
      ? `Credit Note ${creditNote.credit_note_number} - Customer deposit for overpayment${creditNote.invoice_number ? ` on Invoice ${creditNote.invoice_number}` : ''}`
      : `Credit Note ${creditNote.credit_note_number} - AR Reduction`;

    const entries: GLEntry[] = [
      { account_id: accountMappings.revenue_account_id, debit_amount: creditNote.subtotal, credit_amount: 0, description: `Credit Note ${creditNote.credit_note_number} - Revenue reversal${creditNote.invoice_number ? ` for Invoice ${creditNote.invoice_number}` : ''}` },
      { account_id: creditAccountId, debit_amount: 0, credit_amount: creditNote.total, description: creditDescription, contact_id: creditNote.contact_id },
    ];

    if (creditNote.tax_amount > 0 && accountMappings.tax_liability_account_id) {
      entries.push({ account_id: accountMappings.tax_liability_account_id, debit_amount: creditNote.tax_amount, credit_amount: 0, description: `Credit Note ${creditNote.credit_note_number} - Tax reversal` });
    }

    const memo = useCustomerDeposits
      ? `Credit issued for overpayment${creditNote.invoice_number ? ` on Invoice ${creditNote.invoice_number}` : ''}`
      : `Credit Note ${creditNote.credit_note_number} issued`;

    return postToGL({ source_type: "credit_note", source_id: creditNote.id, reference: creditNote.credit_note_number, memo, entry_date: creditNote.issue_date, entries });
  };

  /**
   * Post a bank reconciliation adjustment to GL.
   * Used when a bank transaction has no matching GL entry and needs one created.
   */
  const postBankReconToGL = async (bankTxn: {
    id: string;
    transaction_date: string;
    amount: number;
    description: string;
    transaction_type: "credit" | "debit";
  }, accountMappings: {
    bank_account_id: string;
    offset_account_id: string;
  }) => {
    const isCredit = bankTxn.transaction_type === "credit";
    const entries: GLEntry[] = [
      {
        account_id: accountMappings.bank_account_id,
        debit_amount: isCredit ? Math.abs(bankTxn.amount) : 0,
        credit_amount: isCredit ? 0 : Math.abs(bankTxn.amount),
        description: `Bank Recon: ${bankTxn.description}`,
      },
      {
        account_id: accountMappings.offset_account_id,
        debit_amount: isCredit ? 0 : Math.abs(bankTxn.amount),
        credit_amount: isCredit ? Math.abs(bankTxn.amount) : 0,
        description: `Bank Recon: ${bankTxn.description}`,
      },
    ];

    return postToGL({
      source_type: "bank_recon",
      source_id: bankTxn.id,
      reference: `BRECON-${bankTxn.id.slice(0, 8)}`,
      memo: `Bank reconciliation: ${bankTxn.description}`,
      entry_date: bankTxn.transaction_date,
      entries,
    });
  };

  /**
   * Post a refund to GL.
   * When a credit note is refunded (cash returned to customer):
   *   - If CN was posted to Customer Deposits (paid invoice): DR Customer Deposits, CR Cash/Bank
   *   - If CN was posted to AR (unpaid invoice): DR AR, CR Cash/Bank
   */
  const postRefundToGL = async (refund: {
    id: string;
    credit_note_number: string;
    refund_date: string;
    amount: number;
    is_fully_paid?: boolean;
    contact_id?: string;
  }, accountMappings: {
    receivable_account_id: string;
    payment_account_id: string;
    customer_deposits_account_id?: string;
  }) => {
    // Reverse the same account that was credited during CN issuance
    const useCustomerDeposits = refund.is_fully_paid && accountMappings.customer_deposits_account_id;
    const debitAccountId = useCustomerDeposits
      ? accountMappings.customer_deposits_account_id!
      : accountMappings.receivable_account_id;
    const debitDescription = useCustomerDeposits
      ? `Refund ${refund.credit_note_number} - Customer deposit reversal`
      : `Refund ${refund.credit_note_number} - AR reversal`;

    return postToGL({
      source_type: "credit_note",
      source_id: refund.id,
      source_subtype: "refund",
      reference: `REF-${refund.credit_note_number}`,
      memo: `Refund for Credit Note ${refund.credit_note_number}`,
      entry_date: refund.refund_date,
      entries: [
        { account_id: debitAccountId, debit_amount: refund.amount, credit_amount: 0, description: debitDescription, contact_id: refund.contact_id },
        { account_id: accountMappings.payment_account_id, debit_amount: 0, credit_amount: refund.amount, description: `Refund ${refund.credit_note_number} - Cash out` },
      ],
    });
  };

  return {
    postToGL,
    postBillToGL,
    postPaymentToGL,
    postExpenseToGL,
    postCreditNoteToGL,
    postRefundToGL,
    postBankReconToGL,
  };
}
