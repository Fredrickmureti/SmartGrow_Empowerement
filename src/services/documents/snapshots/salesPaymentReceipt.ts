/**
 * Wave 7.2 · Step 5 — Customer payment receipt snapshot builder.
 *
 * Mirrors `supabase/functions/generate-document/index.ts::fetchReceipt`
 * (`document_kinds.code = 'sales.payment_receipt'`). Implements the same
 * items-as-truth allocation contract so a client-built snapshot and the
 * legacy server-side fetcher produce byte-equivalent renderer input.
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
  currency: string | null;
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
      currency: inv.currency || payment.currency || "USD",
    };
  });

  const allocCurrencies = new Set(
    allocations.map((a) => a.currency).filter(Boolean) as string[],
  );
  const uniformAlloc = allocCurrencies.size === 1
    ? [...allocCurrencies][0]
    : null;
  const displayCurrency =
    uniformAlloc ??
    payment.currency ??
    payment.business?.base_currency ??
    "USD";

  const paymentAmount = Number(payment.amount) || 0;
  const totalApplied = allocations.reduce((s, a) => s + a.amount_applied, 0);
  const displayAmount = allocations.length > 0 ? totalApplied : paymentAmount;
  const unapplied =
    restrictToInvoiceId || allocations.length === 0
      ? 0
      : Math.max(0, paymentAmount - totalApplied);

  const items: Array<Record<string, unknown>> = [];
  if (allocations.length > 0) {
    for (const a of allocations) {
      items.push({
        description: a.invoice_date
          ? `Invoice ${a.invoice_number}  (${a.invoice_date})`
          : `Invoice ${a.invoice_number}`,
        quantity: 1,
        unit_price: a.amount_applied,
        tax_rate: 0,
        tax_amount: 0,
        line_total: a.amount_applied,
      });
    }
    if (unapplied > 0) {
      items.push({
        description: "Unapplied advance (on account)",
        quantity: 1,
        unit_price: unapplied,
        tax_rate: 0,
        tax_amount: 0,
        line_total: unapplied,
      });
    }
  } else {
    items.push({
      description: "On-account payment",
      quantity: 1,
      unit_price: displayAmount,
      tax_rate: 0,
      tax_amount: 0,
      line_total: displayAmount,
    });
  }

  const itemsSubtotal = items.reduce(
    (s, it) => s + (Number(it.line_total) || 0),
    0,
  );
  const itemsTax = items.reduce(
    (s, it) => s + (Number(it.tax_amount) || 0),
    0,
  );
  const itemsTotal = itemsSubtotal + itemsTax;

  const documentNumber =
    payment.receipt_number || `RCP-${payment.id.slice(0, 8)}`;

  const snapshot: SnapshotBlob = {
    document_type: "receipt",
    document_type_label: "PAYMENT RECEIPT",
    document_number: documentNumber,
    status: payment.status || "completed",
    issue_date: payment.payment_date,
    subtotal: itemsSubtotal,
    tax_amount: itemsTax,
    discount_amount: 0,
    total: itemsTotal,
    amount_paid: itemsTotal,
    currency: displayCurrency,
    notes: payment.notes,
    terms: null,
    contact: payment.contact,
    business_id: payment.business_id,
    organization_id: payment.organization_id,
    branch_id: payment.branch_id,
    items,
    payment_method: payment.payment_method
      ? PAYMENT_METHOD_LABELS[payment.payment_method] || payment.payment_method
      : null,
    payment_reference: payment.reference ?? null,
    payment_allocations: allocations,
    unapplied_amount: unapplied,
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
      id, receipt_number, payment_date, amount, status, currency, notes,
      payment_method, reference,
      organization_id, business_id, branch_id,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code),
      business:businesses(id, name, legal_name, base_currency, logo_url, address, email, phone)
      `,
    )
    .eq("id", paymentId)
    .single();

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
    return p != null && (p.status ?? "completed") !== "voided";
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
