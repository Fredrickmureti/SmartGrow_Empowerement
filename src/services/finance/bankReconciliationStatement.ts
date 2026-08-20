/**
 * Bank reconciliation statement — client seam.
 *
 * The bank-to-book proof is accounting output. It is produced by
 * `finance_bank_reconciliation_statement` in SQL from bank statement lines
 * and posted journal entries, and consumed verbatim here. This module is the
 * ONLY caller of that RPC.
 *
 * Never re-derive the proof in the browser: the client cannot see every
 * statement line or posted line (row limits), cannot decide which entries are
 * already matched, and cannot detect a shared GL account. The engine returns
 * both adjusted balances plus their residual — a non-zero residual is a
 * bookkeeping finding to surface, never to hide.
 */

import { supabase } from "@/integrations/supabase/client";

export interface ReconciliationItem {
  id: string;
  journalEntryId: string | null;
  date: string;
  reference: string | null;
  description: string | null;
  source: string | null;
  amount: number;
}

export interface ReconciliationItemGroup {
  label: string;
  total: number;
  count: number;
  items: ReconciliationItem[];
  truncated: boolean;
}

export interface ReconciliationAccount {
  id: string;
  name: string;
  bankName: string | null;
  accountNumber: string | null;
  currency: string;
  businessId: string | null;
  branchId: string | null;
  lifecycleStatus: string | null;
  glAccountId: string | null;
  glAccountCode: string | null;
  glAccountName: string | null;
}

export interface ReconciliationSessionRef {
  id: string;
  statementDate: string;
  status: string;
  closingBalance: number;
  difference: number | null;
  completedAt: string | null;
}

export interface ReconciliationDiagnostics {
  glAccountMissing: boolean;
  glAccountShared: boolean;
  glCurrencyFallbackLines: number;
  statementLineCount: number;
  lastStatementDate: string | null;
  clearedWithoutPosting: number;
  latestSession: ReconciliationSessionRef | null;
}

export interface BankReconciliationStatement {
  account: ReconciliationAccount;
  asOf: string;
  currency: string;
  bank: {
    openingBalance: number;
    openingBalanceDate: string | null;
    openingBalanceEffective: boolean;
    statementLinesNet: number;
    statementBalance: number;
    depositsInTransit: ReconciliationItemGroup;
    unpresentedPayments: ReconciliationItemGroup;
    adjustedBalance: number;
  };
  book: {
    glBalance: number | null;
    unrecordedReceipts: ReconciliationItemGroup;
    unrecordedCharges: ReconciliationItemGroup;
    adjustedBalance: number | null;
  };
  residual: number | null;
  inBalance: boolean;
}

export interface BankReconciliationStatementParams {
  orgId: string;
  bankAccountId: string;
  asOf: string;
  businessId?: string | null;
  branchId?: string | null;
}

const num = (value: unknown): number => Number(value ?? 0) || 0;
const str = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);

function normalizeGroup(raw: unknown, fallbackLabel: string): ReconciliationItemGroup {
  const group = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(group.items) ? (group.items as Record<string, unknown>[]) : [];
  return {
    label: String(group.label ?? fallbackLabel),
    total: num(group.total),
    count: Number(group.count ?? items.length) || 0,
    truncated: Boolean(group.truncated),
    items: items.map((item) => ({
      id: String(item.id ?? ""),
      journalEntryId: str(item.journal_entry_id),
      date: String(item.date ?? ""),
      reference: str(item.reference),
      description: str(item.description),
      source: str(item.source),
      amount: num(item.amount),
    })),
  };
}

export async function fetchBankReconciliationStatement(
  params: BankReconciliationStatementParams,
): Promise<BankReconciliationStatement & { diagnostics: ReconciliationDiagnostics }> {
  const { data, error } = await (supabase.rpc as any)(
    "finance_bank_reconciliation_statement",
    {
      _org_id: params.orgId,
      _bank_account_id: params.bankAccountId,
      _as_of: params.asOf,
      _business_id: params.businessId ?? null,
      _branch_id: params.branchId ?? null,
    },
  );

  if (error) throw error;

  const payload = (data ?? {}) as Record<string, unknown>;
  const account = (payload.account ?? {}) as Record<string, unknown>;
  const bank = (payload.bank ?? {}) as Record<string, unknown>;
  const book = (payload.book ?? {}) as Record<string, unknown>;
  const diag = (payload.diagnostics ?? {}) as Record<string, unknown>;
  const session = (diag.latest_session ?? null) as Record<string, unknown> | null;

  const nullableNum = (value: unknown): number | null =>
    value === null || value === undefined ? null : num(value);

  return {
    account: {
      id: String(account.id ?? params.bankAccountId),
      name: String(account.name ?? ""),
      bankName: str(account.bank_name),
      accountNumber: str(account.account_number),
      currency: String(account.currency ?? payload.currency ?? ""),
      businessId: str(account.business_id),
      branchId: str(account.branch_id),
      lifecycleStatus: str(account.lifecycle_status),
      glAccountId: str(account.gl_account_id),
      glAccountCode: str(account.gl_account_code),
      glAccountName: str(account.gl_account_name),
    },
    asOf: String(payload.as_of ?? params.asOf),
    currency: String(payload.currency ?? account.currency ?? ""),
    bank: {
      openingBalance: num(bank.opening_balance),
      openingBalanceDate: str(bank.opening_balance_date),
      openingBalanceEffective: Boolean(bank.opening_balance_effective),
      statementLinesNet: num(bank.statement_lines_net),
      statementBalance: num(bank.statement_balance),
      depositsInTransit: normalizeGroup(bank.deposits_in_transit, "Add: deposits in transit"),
      unpresentedPayments: normalizeGroup(
        bank.unpresented_payments,
        "Less: unpresented payments",
      ),
      adjustedBalance: num(bank.adjusted_balance),
    },
    book: {
      glBalance: nullableNum(book.gl_balance),
      unrecordedReceipts: normalizeGroup(
        book.unrecorded_receipts,
        "Add: receipts on the statement not yet in the books",
      ),
      unrecordedCharges: normalizeGroup(
        book.unrecorded_charges,
        "Less: charges on the statement not yet in the books",
      ),
      adjustedBalance: nullableNum(book.adjusted_balance),
    },
    residual: nullableNum(payload.residual),
    inBalance: Boolean(payload.in_balance),
    diagnostics: {
      glAccountMissing: Boolean(diag.gl_account_missing),
      glAccountShared: Boolean(diag.gl_account_shared),
      glCurrencyFallbackLines: Number(diag.gl_currency_fallback_lines ?? 0) || 0,
      statementLineCount: Number(diag.statement_line_count ?? 0) || 0,
      lastStatementDate: str(diag.last_statement_date),
      clearedWithoutPosting: Number(diag.cleared_without_posting ?? 0) || 0,
      latestSession: session
        ? {
            id: String(session.id ?? ""),
            statementDate: String(session.statement_date ?? ""),
            status: String(session.status ?? ""),
            closingBalance: num(session.closing_balance),
            difference: nullableNum(session.difference),
            completedAt: str(session.completed_at),
          }
        : null,
    },
  };
}
