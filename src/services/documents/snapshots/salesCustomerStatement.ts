/**
 * Customer statement snapshot builder — the export projection of the ONE
 * canonical statement dataset.
 *
 * SOURCE OF TRUTH: `customer_ledger_entries` (posted AR subledger), read
 * through `fetchCustomerLedgerRows` and folded by `buildStatementDataset`,
 * exactly as the on-screen statement does. This module used to re-derive the
 * statement from `invoices` + `payments` + `credit_notes`; that second engine
 * charged draft/void invoices to the customer, ignored branch and currency,
 * could not see refunds / deposits / payment reversals, and filtered credit
 * notes on a `credit_note_status` value that does not exist in the enum
 * (`partially_applied`) — which is why statement PDFs failed with HTTP 400.
 *
 * Aging comes from the GL-anchored open-items projection through the one
 * shared helper (`fetchContactOpenItemAging`), aged as of the period end.
 *
 * The renderer reads:
 *   - `statement_transactions[]` — ledger rows with running balance
 *   - `statement_aging[]` — canonical aging summary
 *   - `statement_opening_balance` / `statement_closing_balance`
 *   - `statement_period_start` / `statement_period_end`
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";
import {
  buildStatementDataset,
  type StatementDataset,
} from "@/services/finance/customerStatementDataset";
import { fetchCustomerLedgerRows } from "@/services/finance/customerStatementLedger";
import { fetchContactOpenItemAging } from "@/services/finance/openItems";
import {
  AGING_BUCKET_KEYS,
  AGING_BUCKET_LABELS,
  EMPTY_AGING_BUCKETS,
  type AgingBuckets,
} from "@/services/finance/aging";
import { expandToCommercialPartnerSet } from "@/lib/contactHierarchy";

export interface StatementContactRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  tax_id?: string | null;
}

export interface StatementBusinessRow {
  id: string;
  name?: string | null;
  base_currency?: string | null;
}

export interface StatementHeaderRow {
  id: string;
  contact_id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  period_start: string;
  period_end: string;
  statement_date: string | null;
  created_at: string;
  opening_balance: number | null;
  closing_balance: number | null;
  total_invoiced: number | null;
  total_payments: number | null;
  sent_at: string | null;
  contact: StatementContactRow | null;
  business: StatementBusinessRow | null;
}

export interface StatementTransactionOut {
  date: string;
  type: string;
  reference: string;
  description: string;
  charges: number;
  credits: number;
  balance: number;
  /** Drill-down anchor: the originating business document. */
  source_id?: string;
  source_type?: string;
}

export interface StatementAgingBucketOut {
  label: string;
  amount: number;
}

export interface BuildStatementSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
}

export interface BuildStatementInput {
  statement: StatementHeaderRow;
  /** The canonical dataset folded from `customer_ledger_entries`. */
  dataset: StatementDataset;
  /** Canonical aging buckets, aged as of the period end. */
  aging?: AgingBuckets;
}

const TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  payment: "Payment",
  credit_note: "Credit Note",
  deposit: "Deposit",
  refund: "Refund",
  payment_reversal: "Payment Reversal",
};

function labelFor(docType: string): string {
  return TYPE_LABEL[docType] ?? docType.replace(/_/g, " ");
}

/**
 * Pure builder. Deterministic: the same header + dataset always produce the
 * same snapshot — no clock, no ambient state.
 */
export function buildCustomerStatementSnapshot(
  input: BuildStatementInput,
): BuildStatementSnapshotResult {
  const { statement, dataset } = input;
  if (!statement.id) throw new Error("buildCustomerStatementSnapshot: id required");
  if (!statement.period_start || !statement.period_end) {
    throw new Error("buildCustomerStatementSnapshot: period_start / period_end required");
  }
  if (!dataset) throw new Error("buildCustomerStatementSnapshot: dataset required");

  const statement_transactions: StatementTransactionOut[] = dataset.transactions.map((t) => ({
    date: t.date,
    type: labelFor(t.docType),
    reference: t.reference,
    description: t.description,
    charges: t.debit,
    credits: t.credit,
    balance: t.balance,
    source_id: t.sourceId,
    source_type: t.docType,
  }));

  const aging = input.aging ?? EMPTY_AGING_BUCKETS;
  const statement_aging: StatementAgingBucketOut[] = AGING_BUCKET_KEYS.map((k) => ({
    label: AGING_BUCKET_LABELS[k],
    amount: Number(aging[k]) || 0,
  }));

  const currency = statement.business?.base_currency || "USD";
  const openingBalance = dataset.openingBalance;
  const closingBalance = dataset.closingBalance;
  const documentNumber = `Statement - ${statement.contact?.name || "Customer"}`;
  const issueDateIso = statement.statement_date || statement.created_at;

  // ADR 0136: a printed statement whose aging excludes unconvertible documents
  // must say so on the face of the document, not silently under-report.
  const unconvertibleNote =
    (aging.unconvertible_document_count || 0) > 0
      ? `${aging.unconvertible_document_count} open document(s) are in a currency with no exchange rate on file and are excluded from the aging summary.`
      : null;

  const snapshot: SnapshotBlob = {
    document_number: documentNumber,
    document_type: "customer_statement",
    document_type_label: "CUSTOMER STATEMENT",
    status: statement.sent_at ? "sent" : "draft",
    issue_date: issueDateIso,
    subtotal: dataset.totalCharges,
    tax_amount: 0,
    discount_amount: 0,
    total: closingBalance,
    amount_paid: dataset.totalCredits,
    currency,
    notes: [
      dataset.otherCurrencies.length
        ? `This statement covers ${currency} activity only. This customer also has activity in: ${dataset.otherCurrencies.join(
            ", ",
          )}.`
        : null,
      unconvertibleNote,
    ]
      .filter(Boolean)
      .join(" ") || null,
    terms: null,
    contact: statement.contact,
    business_id: statement.business_id,
    organization_id: statement.organization_id,
    branch_id: statement.branch_id,
    items: [],
    statement_transactions,
    statement_aging,
    statement_opening_balance: openingBalance,
    statement_closing_balance: closingBalance,
    statement_period_start: statement.period_start,
    statement_period_end: statement.period_end,
  };

  const documentDate = (issueDateIso || statement.period_end).slice(0, 10);

  return {
    snapshot,
    documentNumber,
    documentDate,
    organizationId: statement.organization_id,
    businessId: statement.business_id,
    branchId: statement.branch_id,
    currency,
    sourceDocId: statement.id,
  };
}

export async function fetchAndBuildCustomerStatementSnapshot(
  supabase: SupabaseClient,
  statementId: string,
  opts?: { consolidate?: boolean },
): Promise<BuildStatementSnapshotResult> {
  const { data: stmt, error } = await supabase
    .from("customer_statements")
    .select(
      `
      id, contact_id, organization_id, business_id, branch_id,
      period_start, period_end, statement_date, created_at,
      opening_balance, closing_balance, total_invoiced, total_payments, sent_at,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, country, tax_id),
      business:businesses(id, name, base_currency)
      `,
    )
    .eq("id", statementId)
    .single();

  if (error || !stmt) {
    throw new Error(
      `fetchAndBuildCustomerStatementSnapshot: statement ${statementId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }

  const s = stmt as unknown as StatementHeaderRow;
  if (!s.business_id) {
    throw new Error(
      `fetchAndBuildCustomerStatementSnapshot: statement ${statementId} has no business_id`,
    );
  }

  const contactIds = opts?.consolidate
    ? await expandToCommercialPartnerSet(s.contact_id, {
        organizationId: s.organization_id,
        businessId: s.business_id,
      })
    : [s.contact_id];

  const rows = await fetchCustomerLedgerRows(supabase, {
    organizationId: s.organization_id,
    businessId: s.business_id,
    branchId: s.branch_id,
    contactIds,
    periodEnd: s.period_end,
  });

  const dataset = buildStatementDataset({
    rows,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    currency: s.business?.base_currency ?? null,
  });

  const aging = await fetchContactOpenItemAging("ar", {
    orgId: s.organization_id,
    contactId: contactIds,
    businessId: s.business_id,
    branchId: s.branch_id,
    asOf: s.period_end,
  });

  return buildCustomerStatementSnapshot({ statement: s, dataset, aging });
}
