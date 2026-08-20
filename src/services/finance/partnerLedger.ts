/**
 * Partner Ledger — client seam.
 *
 * The Partner Ledger is an accounting projection of the AR / AP sub-ledger.
 * Opening balances, running balances and closing balances are computed by
 * `finance_partner_ledger` in SQL and consumed verbatim here. This module is
 * the ONLY way the app may obtain partner ledger figures.
 *
 * Never reintroduce the previous approach (page every ledger row into the
 * browser and fold balances in JavaScript): it is unbounded, it re-derives
 * accounting output away from the ledger, and its branch predicate
 * (`branch_id = X OR branch_id IS NULL`) leaked unbranched entries into a
 * branch-scoped report.
 */

import { supabase } from "@/integrations/supabase/client";

export type PartnerLedgerSide = "customer" | "supplier";

export interface PartnerLedgerTransaction {
  /** Stable row key: `${doc_type}:${doc_id}`. */
  id: string;
  entry_date: string;
  /** Document reference as printed on the source document. */
  entry_number: string;
  /** Document kind (invoice, payment, credit note, journal, …). */
  description: string;
  debit: number;
  credit: number;
  /** Server-computed running balance, base currency. */
  running_balance: number;
  journal_entry_id: string | null;
}

export interface PartnerLedgerPartner {
  contact_id: string;
  contact_name: string;
  opening_balance: number;
  total_debit: number;
  total_credit: number;
  closing_balance: number;
  movement_count: number;
  transactions: PartnerLedgerTransaction[];
}

export interface PartnerLedgerTotals {
  opening_balance: number;
  total_debit: number;
  total_credit: number;
  closing_balance: number;
  partner_count: number;
}

export interface PartnerLedgerResult {
  side: "customer" | "vendor";
  from: string | null;
  to: string;
  currency: string | null;
  partners: PartnerLedgerPartner[];
  totals: PartnerLedgerTotals;
  page: {
    limit: number | null;
    offset: number;
    search: string | null;
    returned: number;
    has_more: boolean;
  };
}

export interface PartnerLedgerParams {
  orgId: string;
  businessId: string;
  branchId?: string | null;
  side: PartnerLedgerSide;
  from: string;
  to: string;
  contactId?: string | null;
  search?: string | null;
  limit?: number | null;
  offset?: number;
}

const num = (value: unknown): number => Number(value ?? 0) || 0;

export const EMPTY_PARTNER_LEDGER_TOTALS: PartnerLedgerTotals = {
  opening_balance: 0,
  total_debit: 0,
  total_credit: 0,
  closing_balance: 0,
  partner_count: 0,
};

function normalizePartner(raw: Record<string, unknown>): PartnerLedgerPartner {
  const transactions = Array.isArray(raw.transactions) ? raw.transactions : [];
  return {
    contact_id: String(raw.contact_id ?? ""),
    contact_name: String(raw.contact_name ?? "Unknown Partner"),
    opening_balance: num(raw.opening_balance),
    total_debit: num(raw.total_debit),
    total_credit: num(raw.total_credit),
    closing_balance: num(raw.closing_balance),
    movement_count: Number(raw.movement_count ?? 0) || 0,
    transactions: (transactions as Record<string, unknown>[]).map((t) => ({
      id: `${String(t.doc_type ?? "entry")}:${String(t.doc_id ?? "")}`,
      entry_date: String(t.entry_date ?? ""),
      entry_number: String(t.doc_ref ?? ""),
      description: String(t.doc_type ?? ""),
      debit: num(t.debit),
      credit: num(t.credit),
      running_balance: num(t.running_balance),
      journal_entry_id: (t.journal_entry_id as string | null) ?? null,
    })),
  };
}

/** Fetch one page of the partner ledger. Balances come from SQL untouched. */
export async function fetchPartnerLedger(
  params: PartnerLedgerParams,
): Promise<PartnerLedgerResult> {
  const { data, error } = await (supabase.rpc as any)("finance_partner_ledger", {
    _org_id: params.orgId,
    _business_id: params.businessId,
    _branch_id: params.branchId ?? null,
    _side: params.side === "supplier" ? "vendor" : "customer",
    _from: params.from,
    _to: params.to,
    _contact_id: params.contactId ?? null,
    _search: params.search ?? null,
    _limit: params.limit ?? null,
    _offset: params.offset ?? 0,
  });

  if (error) throw error;

  const payload = (data ?? {}) as Record<string, unknown>;
  const partners = Array.isArray(payload.partners) ? payload.partners : [];
  const totals = (payload.totals ?? {}) as Record<string, unknown>;
  const page = (payload.page ?? {}) as Record<string, unknown>;

  return {
    side: payload.side === "vendor" ? "vendor" : "customer",
    from: (payload.from as string | null) ?? null,
    to: String(payload.to ?? params.to),
    currency: (payload.currency as string | null) ?? null,
    partners: (partners as Record<string, unknown>[]).map(normalizePartner),
    totals: {
      opening_balance: num(totals.opening_balance),
      total_debit: num(totals.total_debit),
      total_credit: num(totals.total_credit),
      closing_balance: num(totals.closing_balance),
      partner_count: Number(totals.partner_count ?? 0) || 0,
    },
    page: {
      limit: (page.limit as number | null) ?? null,
      offset: Number(page.offset ?? 0) || 0,
      search: (page.search as string | null) ?? null,
      returned: Number(page.returned ?? 0) || 0,
      has_more: Boolean(page.has_more),
    },
  };
}

export interface PartnerLedgerReconciliation {
  ledgerTotal: number;
  controlAccountBalance: number;
  variance: number;
  inBalance: boolean;
}

/**
 * Tie the partner ledger's closing position to the AR / AP control account.
 * A non-zero variance is a bookkeeping finding, never a rounding artefact to
 * hide — surface it.
 */
export async function fetchPartnerLedgerReconciliation(params: {
  orgId: string;
  businessId: string;
  branchId?: string | null;
  side: PartnerLedgerSide;
  to: string;
}): Promise<PartnerLedgerReconciliation | null> {
  const { data, error } = await (supabase.rpc as any)(
    "finance_partner_ledger_reconciliation",
    {
      _org_id: params.orgId,
      _business_id: params.businessId,
      _branch_id: params.branchId ?? null,
      _side: params.side === "supplier" ? "vendor" : "customer",
      _to: params.to,
    },
  );

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return null;

  return {
    ledgerTotal: num(row.ledger_total),
    controlAccountBalance: num(row.control_account_balance),
    variance: num(row.variance),
    inBalance: Boolean(row.in_balance),
  };
}
