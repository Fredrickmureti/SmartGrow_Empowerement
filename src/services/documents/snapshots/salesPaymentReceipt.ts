/**
 * Wave 7.2 · Step 5 — Customer payment receipt snapshot builder.
 *
 * Canonical projection for `document_kinds.code = 'sales.payment_receipt'`.
 * Payment rows do not carry a currency; currency belongs to the allocated
 * invoice or, for an on-account payment, the payment's business.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  bank_transfer: "Bank Transfer",
  cash: "Cash",
  credit_card: "Credit Card",
  check: "Check",
  mobile_money: "Mobile Money",
  other: "Other",
};

export interface PaymentContactRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export interface PaymentBusinessRow {
  id: string;
  name: string | null;
  legal_name?: string | null;
  base_currency?: string | null;
  logo_url?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  /** Company-level receipt presentation profile (`businesses.receipt_settings`). */
  receipt_settings?: Record<string, unknown> | null;
}

export interface PaymentAllocationRow {
  invoice_id: string;
  amount: number;
  invoices: {
    id: string;
    invoice_number: string | null;
    issue_date: string | null;
    total: number | null;
    amount_paid: number | null;
    currency: string | null;
  } | null;
}

export interface PaymentHeaderRow {
  id: string;
  receipt_number: string | null;
  payment_date: string;
  amount: number;
  status: string | null;
  notes: string | null;
  payment_method: string | null;
  reference: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  contact: PaymentContactRow | null;
  business: PaymentBusinessRow | null;
}

export interface BuildPaymentReceiptSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
}

const ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy",
  "Eighty", "Ninety",
];

function under1000ToWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const r = n % 10;
    return r ? `${t}-${ONES[r]}` : t;
  }
  const h = Math.floor(n / 100);
  const r = n % 100;
  return r ? `${ONES[h]} Hundred ${under1000ToWords(r)}` : `${ONES[h]} Hundred`;
}

/**
 * Amount in words — required on an official receipt in most jurisdictions
 * (and expected by auditors on cash-application documents). English only;
 * localisation happens at the template layer when a tenant needs it.
 */
export function amountInWords(amount: number, currency: string): string {
  const value = Math.abs(Number(amount) || 0);
  const whole = Math.floor(value);
  const cents = Math.round((value - whole) * 100);
  const scales: Array<[number, string]> = [
    [1_000_000_000, "Billion"],
    [1_000_000, "Million"],
    [1_000, "Thousand"],
  ];
  let rest = whole;
  const parts: string[] = [];
  for (const [size, name] of scales) {
    const q = Math.floor(rest / size);
    if (q > 0) {
      parts.push(`${under1000ToWords(q)} ${name}`);
      rest -= q * size;
    }
  }
  if (rest > 0 || parts.length === 0) parts.push(under1000ToWords(rest));
  const head = `${currency ? currency + " " : ""}${parts.join(" ")}`;
  return cents > 0
    ? `${head} and ${under1000ToWords(cents)}/100 only`
    : `${head} only`;
}

/**
 * Pure builder. Deterministic: given the same payment + allocations,
 * always produces the same snapshot JSON.
 *
 * @param restrictToInvoiceId  when set, only allocations for that invoice
 *   are rendered — the "View receipt" action on a specific invoice row.
 */
export function buildPaymentReceiptSnapshot(
  payment: PaymentHeaderRow,
  allocationsInput: PaymentAllocationRow[],
  restrictToInvoiceId: string | null = null,
): BuildPaymentReceiptSnapshotResult {
  if (!payment.id) throw new Error("buildPaymentReceiptSnapshot: id required");
  if (!payment.payment_date) {
    throw new Error("buildPaymentReceiptSnapshot: payment_date required");
  }

  const rows = (allocationsInput ?? []).filter((r) => r.invoices != null);
  const scoped = restrictToInvoiceId
    ? rows.filter((r) => r.invoice_id === restrictToInvoiceId)
    : rows.slice();

  // Stable, accountant-friendly order: issue_date, then invoice_number.
  scoped.sort((a, b) => {
    const da = a.invoices?.issue_date ?? "";
    const db = b.invoices?.issue_date ?? "";
    if (da !== db) return da < db ? -1 : 1;
    const na = a.invoices?.invoice_number ?? "";
    const nb = b.invoices?.invoice_number ?? "";
    return na < nb ? -1 : na > nb ? 1 : 0;
  });

  const allocations = scoped.map((r) => {
    const inv = r.invoices!;
    const applied = Number(r.amount) || 0;
    const total = Number(inv.total ?? 0) || 0;
    const paid = Number(inv.amount_paid ?? 0) || 0;
    const balance = Math.max(0, total - paid);
    return {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number || "",
      invoice_date: inv.issue_date ?? null,
      invoice_total: total,
      amount_applied: applied,
      balance_after: balance,
      currency: inv.currency || payment.business?.base_currency || "",
    };
  });

  const allocCurrencies = new Set(
    allocations.map((a) => a.currency).filter(Boolean) as string[],
  );
  const uniformAlloc = allocCurrencies.size === 1
    ? [...allocCurrencies][0]
    : null;
  if (allocCurrencies.size > 1) {
    throw new Error(
      "buildPaymentReceiptSnapshot: allocations contain multiple currencies",
    );
  }
  const displayCurrency = uniformAlloc ?? payment.business?.base_currency;
  if (!displayCurrency) {
    throw new Error(
      "buildPaymentReceiptSnapshot: currency is missing from both allocations and business",
    );
  }

  const paymentAmount = Number(payment.amount) || 0;
  const totalApplied = allocations.reduce((s, a) => s + a.amount_applied, 0);
  const displayAmount = allocations.length > 0 ? totalApplied : paymentAmount;
  const unapplied =
    restrictToInvoiceId || allocations.length === 0
      ? 0
      : Math.max(0, paymentAmount - totalApplied);

  // A payment receipt is a CASH-APPLICATION document, not a sale. It has no
  // product grid: restating the invoice lines (or synthesising fake ones from
  // the allocations) double-states the supply and its tax. The allocation
  // ledger below IS the body — same rule NetSuite/Odoo/SAP follow.
  const items: Array<Record<string, unknown>> = [];
  const amountReceived = displayAmount + unapplied;
  // Outstanding left on the documents this receipt touched. A true AR
  // balance needs the whole ledger; this is the honest, receipt-scoped number.
  const balanceOnAppliedDocs = allocations.reduce(
    (s, a) => s + (Number(a.balance_after) || 0),
    0,
  );

  const documentNumber =
    payment.receipt_number || `RCP-${payment.id.slice(0, 8)}`;
  const methodLabel = payment.payment_method
    ? PAYMENT_METHOD_LABELS[payment.payment_method] || payment.payment_method
    : null;

  const snapshot: SnapshotBlob = {
    document_type: "receipt",
    document_type_label: "PAYMENT RECEIPT",
    document_number: documentNumber,
    status: payment.status || "applied",
    issue_date: payment.payment_date,
    subtotal: amountReceived,
    tax_amount: 0,
    discount_amount: 0,
    total: amountReceived,
    amount_paid: amountReceived,
    currency: displayCurrency,
    notes: payment.notes,
    terms: null,
    contact: payment.contact,
    business_id: payment.business_id,
    organization_id: payment.organization_id,
    branch_id: payment.branch_id,
    items,
    // Cash-application facts (the reason this document exists).
    is_payment_document: true,
    received_from: payment.contact?.name ?? null,
    payment_method: methodLabel,
    payment_method_code: payment.payment_method ?? null,
    payment_reference: payment.reference ?? null,
    payment_allocations: allocations,
    unapplied_amount: unapplied,
    total_applied: totalApplied,
    amount_received: amountReceived,
    customer_balance_after: balanceOnAppliedDocs,
    amount_in_words: amountInWords(amountReceived, displayCurrency),
    // Branding/typesetting profile frozen at issue time, exactly like POS.
    pos_receipt_settings:
      (payment.business?.receipt_settings as Record<string, unknown> | null) ?? null,
  };

  return {
    snapshot,
    documentNumber,
    documentDate: payment.payment_date.slice(0, 10),
    organizationId: payment.organization_id,
    businessId: payment.business_id,
    branchId: payment.branch_id,
    currency: displayCurrency,
    sourceDocId: payment.id,
  };
}

export async function fetchAndBuildPaymentReceiptSnapshot(
  supabase: SupabaseClient,
  paymentId: string,
  opts?: { restrictToInvoiceId?: string | null },
): Promise<BuildPaymentReceiptSnapshotResult> {
  const { data: payment, error: pErr } = await supabase
    .from("payments")
    .select(
      `
       id, receipt_number, payment_date, amount, status, notes,
      payment_method, reference,
      organization_id, business_id, branch_id,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code),
      business:businesses(id, name, legal_name, base_currency, logo_url, address, email, phone, receipt_settings)
      `,
    )
    .eq("id", paymentId)
    .maybeSingle();

  if (pErr || !payment) {
    throw new Error(
      `fetchAndBuildPaymentReceiptSnapshot: payment ${paymentId} not found: ${
        pErr?.message ?? "no row"
      }`,
    );
  }

  const { data: allocRows, error: aErr } = await supabase
    .from("payment_allocations")
    .select(
      "invoice_id, amount, invoices(id, invoice_number, issue_date, total, amount_paid, currency)",
    )
    .eq("payment_id", paymentId);

  if (aErr) {
    throw new Error(
      `fetchAndBuildPaymentReceiptSnapshot: allocations for ${paymentId} failed: ${aErr.message}`,
    );
  }

  return buildPaymentReceiptSnapshot(
    payment as unknown as PaymentHeaderRow,
    (allocRows ?? []) as unknown as PaymentAllocationRow[],
    opts?.restrictToInvoiceId ?? null,
  );
}
/**
 * Anchor-agnostic receipt resolution.
 *
 * The legacy `receipt` document type is triggered from two places with two
 * different ids: Sales → Payments passes a payment id, while the invoice
 * row action ("View receipt") passes an *invoice* id. Both must land on the
 * same snapshot builder — the invoice case simply restricts the rendered
 * allocations to that invoice.
 */
export interface ResolvedReceiptSnapshot extends BuildPaymentReceiptSnapshotResult {
  /** Which id the caller supplied. */
  anchor: "payment" | "invoice";
  anchorId: string;
}

export async function resolveAndBuildReceiptSnapshot(
  supabase: SupabaseClient,
  anchorId: string,
): Promise<ResolvedReceiptSnapshot> {
  if (!anchorId) throw new Error("resolveAndBuildReceiptSnapshot: id required");

  const { data: asPayment } = await supabase
    .from("payments")
    .select("id")
    .eq("id", anchorId)
    .maybeSingle();

  if (asPayment?.id) {
    const built = await fetchAndBuildPaymentReceiptSnapshot(supabase, anchorId);
    return { ...built, anchor: "payment", anchorId };
  }

  // Invoice anchor: pick the most recent settled payment touching it.
  const { data: allocs, error } = await supabase
    .from("payment_allocations")
    .select("payment_id, payments(id, payment_date, status)")
    .eq("invoice_id", anchorId);

  if (error) {
    throw new Error(
      `resolveAndBuildReceiptSnapshot: allocations for invoice ${anchorId} failed: ${error.message}`,
    );
  }

  const live = (allocs ?? []).filter((r) => {
    const p = (r as { payments?: { status?: string | null } }).payments;
    return p != null && (p.status ?? "applied") !== "voided";
  });

  if (live.length === 0) {
    throw new Error(
      `no_receipt_for_invoice: invoice ${anchorId} has no payment to receipt`,
    );
  }

  live.sort((a, b) => {
    const da = (a as { payments?: { payment_date?: string | null } }).payments?.payment_date ?? "";
    const db = (b as { payments?: { payment_date?: string | null } }).payments?.payment_date ?? "";
    return da < db ? 1 : da > db ? -1 : 0;
  });

  const paymentId = (live[0] as { payment_id: string }).payment_id;
  const built = await fetchAndBuildPaymentReceiptSnapshot(supabase, paymentId, {
    restrictToInvoiceId: anchorId,
  });
  return { ...built, anchor: "invoice", anchorId };
}
