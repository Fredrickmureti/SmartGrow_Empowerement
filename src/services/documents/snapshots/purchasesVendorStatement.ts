/**
 * Vendor statement snapshot builder — the export projection of the ONE
 * canonical AP statement dataset.
 *
 * SOURCE OF TRUTH: `vendor_ledger_entries` (posted AP subledger), read
 * through `fetchVendorLedgerRows` and folded by `buildVendorStatementDataset`,
 * exactly as the on-screen vendor statement does. This module used to
 * re-derive the statement from `bills` + `bill_payments` +
 * `vendor_credit_notes`; that second engine hard-coded a status vocabulary,
 * resolved payments through the per-bill FK (mis-attributing any payment that
 * settled several bills), ignored branch scope and currency, and could not
 * see supplier advances or payment reversals.
 *
 * Aging comes from the GL-anchored open-items projection through the one
 * shared helper (`fetchContactOpenItemAging`), aged as of the period end —
 * not `bills.total - amount_paid` against the browser clock.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";
import {
  buildVendorStatementDataset,
  type VendorStatementDataset,
} from "@/services/finance/vendorStatementDataset";
import { fetchVendorLedgerRows } from "@/services/finance/vendorStatementLedger";
import { fetchContactOpenItemAging } from "@/services/finance/openItems";
import {
  AGING_BUCKET_KEYS,
  AGING_BUCKET_LABELS,
  EMPTY_AGING_BUCKETS,
  type AgingBuckets,
} from "@/services/finance/aging";
import { expandToCommercialPartnerSet } from "@/lib/contactHierarchy";

export interface VendorStatementContactRow {
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

export interface VendorStatementBusinessRow {
  id: string;
  name?: string | null;
  base_currency?: string | null;
}

export interface VendorStatementHeaderRow {
  id: string;
  contact_id: string;
  vendor_id?: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  period_start: string;
  period_end: string;
  statement_date: string | null;
  created_at: string;
  opening_balance: number | null;
  closing_balance: number | null;
  total_billed: number | null;
  total_payments: number | null;
  sent_at: string | null;
  contact: VendorStatementContactRow | null;
  business: VendorStatementBusinessRow | null;
}

export interface VendorStatementTransactionOut {
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

export interface VendorStatementAgingBucketOut {
  label: string;
  amount: number;
}

export interface BuildVendorStatementSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
  vendorId: string | null;
}

export interface BuildVendorStatementInput {
  statement: VendorStatementHeaderRow;
  /** The canonical dataset folded from `vendor_ledger_entries`. */
  dataset: VendorStatementDataset;
  /** Canonical aging buckets, aged as of the period end. */
  aging?: AgingBuckets;
}

const TYPE_LABEL: Record<string, string> = {
  bill: "Bill",
  bill_payment: "Payment",
  payment: "Payment",
  vendor_credit_note: "Vendor Credit",
  credit_note: "Vendor Credit",
  advance: "Supplier Advance",
  payment_reversal: "Payment Reversal",
};

function labelFor(docType: string): string {
  return TYPE_LABEL[docType] ?? docType.replace(/_/g, " ");
}

/**
 * Pure builder. Deterministic: the same header + dataset always produce the
 * same snapshot — no clock, no ambient state.
 */
export function buildVendorStatementSnapshot(
  input: BuildVendorStatementInput,
): BuildVendorStatementSnapshotResult {
  const { statement, dataset } = input;
  if (!statement.id) throw new Error("buildVendorStatementSnapshot: id required");
  if (!statement.period_start || !statement.period_end) {
    throw new Error("buildVendorStatementSnapshot: period_start / period_end required");
  }
  if (!dataset) throw new Error("buildVendorStatementSnapshot: dataset required");

  const statement_transactions: VendorStatementTransactionOut[] = dataset.transactions.map(
    (t) => ({
      date: t.date,
      type: labelFor(t.docType),
      reference: t.reference,
      description: t.description,
      charges: t.debit,
      credits: t.credit,
      balance: t.balance,
      source_id: t.sourceId,
      source_type: t.docType,
    }),
  );

  const aging = input.aging ?? EMPTY_AGING_BUCKETS;
  const statement_aging: VendorStatementAgingBucketOut[] = AGING_BUCKET_KEYS.map((k) => ({
    label: AGING_BUCKET_LABELS[k],
    amount: Number(aging[k]) || 0,
  }));

  const currency = statement.business?.base_currency || "USD";
  const openingBalance = dataset.openingBalance;
  const closingBalance = dataset.closingBalance;
  const documentNumber = `Vendor Statement - ${statement.contact?.name || "Vendor"}`;
  const issueDateIso = statement.statement_date || statement.created_at;

  const snapshot: SnapshotBlob = {
    document_number: documentNumber,
    document_type: "vendor_statement",
    document_type_label: "VENDOR STATEMENT",
    status: statement.sent_at ? "sent" : "draft",
    issue_date: issueDateIso,
    subtotal: dataset.totalCharges,
    tax_amount: 0,
    discount_amount: 0,
    total: closingBalance,
    amount_paid: dataset.totalCredits,
    currency,
    notes: dataset.otherCurrencies.length
      ? `This statement covers ${currency} activity only. This vendor also has activity in: ${dataset.otherCurrencies.join(
          ", ",
        )}.`
      : null,
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
    vendorId: statement.vendor_id ?? statement.contact_id ?? null,
  };
}

export async function fetchAndBuildVendorStatementSnapshot(
  supabase: SupabaseClient,
  statementId: string,
  opts?: { consolidate?: boolean },
): Promise<BuildVendorStatementSnapshotResult> {
  const { data: stmt, error } = await supabase
    .from("vendor_statements")
    .select(
      `
      id, contact_id, organization_id, business_id, branch_id,
      period_start, period_end, statement_date, created_at,
      opening_balance, closing_balance, total_billed, total_payments, sent_at,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, country, tax_id),
      business:businesses(id, name, base_currency)
      `,
    )
    .eq("id", statementId)
    .single();

  if (error || !stmt) {
    throw new Error(
      `fetchAndBuildVendorStatementSnapshot: statement ${statementId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }

  const s = stmt as unknown as VendorStatementHeaderRow;
  if (!s.business_id) {
    throw new Error(
      `fetchAndBuildVendorStatementSnapshot: statement ${statementId} has no business_id`,
    );
  }

  const contactIds = opts?.consolidate
    ? await expandToCommercialPartnerSet(s.contact_id, {
        organizationId: s.organization_id,
        businessId: s.business_id,
      })
    : [s.contact_id];

  const rows = await fetchVendorLedgerRows(supabase, {
    organizationId: s.organization_id,
    businessId: s.business_id,
    branchId: s.branch_id,
    contactIds,
    periodEnd: s.period_end,
  });

  const dataset = buildVendorStatementDataset({
    rows,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    currency: s.business?.base_currency ?? null,
  });

  const aging = await fetchContactOpenItemAging("ap", {
    orgId: s.organization_id,
    contactId: contactIds,
    businessId: s.business_id,
    branchId: s.branch_id,
    asOf: s.period_end,
  });

  return buildVendorStatementSnapshot({ statement: s, dataset, aging });
}
