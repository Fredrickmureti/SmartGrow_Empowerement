/**
 * Adapter: `DocumentData` (fetcher output) → `BuildReceiptLinesInput`
 * (engine input). This is the ONLY place that translates fetcher fields
 * into the receipt engine's row producer.
 *
 * Handles TWO document classes:
 *   1. POS receipts (`pos_receipt`, `receipt`) — settings driven by
 *      `pos_receipt_settings` (the tenant's ExtendedReceiptSettings row).
 *   2. Every other thermal-width doc (invoice / quote / PO / delivery
 *      note / sales order / …) — no receipt-settings row exists, so the
 *      adapter synthesises a sensible default settings map that turns on
 *      the blocks a business document needs (recipient, tax breakdown,
 *      currency, notes, terms) while leaving POS-only blocks (cashier,
 *      register, tendered/change, eTIMS) off.
 */

import type { DocumentData, DocumentType, Contact } from "../templateRenderer.ts";
import type {
  BuildReceiptLinesInput,
  ReceiptItemLike,
  ReceiptPaymentLike,
  ReceiptRecipientLike,
  ReceiptTransactionLike,
} from "./lines.ts";

export interface DocToInputOverrides {
  /** Explicit merged receipt settings (wins over `pos_receipt_settings`). */
  settings?: Record<string, unknown>;
  /** Force a title override (e.g. from `resolveReceiptTitle`). */
  title?: string;
  /** Additional company fields (address/city/phone/email) from branch/branding. */
  companyExtras?: Partial<{
    address: string | null;
    city: string | null;
    phone: string | null;
    email: string | null;
  }>;
}

const POS_TYPES: ReadonlySet<DocumentType> = new Set([
  "pos_receipt",
  "receipt",
]);

const TITLE_BY_TYPE: Record<string, string> = {
  invoice: "TAX INVOICE",
  estimate: "QUOTATION",
  proforma: "PROFORMA INVOICE",
  credit_note: "CREDIT NOTE",
  purchase_order: "PURCHASE ORDER",
  receipt: "PAYMENT RECEIPT",
  delivery_note: "DELIVERY NOTE",
  bill: "BILL",
  pos_receipt: "SALES RECEIPT",
  sales_order: "SALES ORDER",
  sales_return: "SALES RETURN",
  customer_statement: "STATEMENT",
  kitchen_ticket: "KITCHEN TICKET",
  offer_letter: "OFFER LETTER",
  promotion_letter: "PROMOTION LETTER",
  warning_letter: "WARNING LETTER",
  contract_letter: "CONTRACT",
};

/** Sensible defaults for a non-POS thermal document. Turned into the
 * settings map when no `pos_receipt_settings` exists on the document. */
function defaultBusinessDocSettings(doc: DocumentData): Record<string, unknown> {
  return {
    paper_size: "80mm",
    font_size: "normal",
    show_store_name: true,
    show_store_address: true,
    show_store_phone: true,
    show_store_email: true,
    show_receipt_number: true,
    show_date_time: true,
    show_status: doc.status && doc.status !== "draft",
    show_customer_name: false, // covered by structured bill_to block
    show_cashier_name: false,
    show_register_id: false,
    show_subtotal: true,
    show_discount_total: true,
    show_tax_breakdown: true,
    show_payment_method: false,   // non-POS docs don't tender at issue time
    show_amount_tendered: false,
    show_change_due: false,
    show_etims_qr: false,
    show_etims_info: false,
    show_return_policy: false,
    item_display_format: "tabular",
    show_item_quantity: true,
    show_unit_price: true,
    show_item_sku: false,
    currency_display: "symbol",
    currency_position: "before",
    date_format: "dmy",
    time_format: "none",
  };
}

function contactToRecipient(
  contact: Contact | null | undefined,
  label: string,
): ReceiptRecipientLike | null {
  if (!contact) return null;
  const address_lines = [
    contact.address_line1,
    [contact.city, contact.state, contact.postal_code]
      .filter(Boolean)
      .join(", ") || null,
    contact.country,
  ].filter((l): l is string => !!l && l.trim().length > 0);
  return {
    label,
    name: contact.name ?? null,
    company: contact.company ?? null,
    address_lines,
    phone: contact.phone ?? null,
    email: contact.email ?? null,
  };
}

export function documentToReceiptInput(
  doc: DocumentData,
  overrides: DocToInputOverrides = {},
): BuildReceiptLinesInput {
  const isPos = POS_TYPES.has(doc.document_type);

  // Base settings resolution:
  //  - explicit overrides win
  //  - else the tenant's stored pos_receipt_settings (POS docs)
  //  - else synthesised business-doc defaults (non-POS thermal docs)
  const storedRs = (doc as unknown as {
    pos_receipt_settings?: Record<string, unknown>;
  }).pos_receipt_settings ?? null;
  const baseRs = overrides.settings
    ?? storedRs
    ?? (isPos ? {} : defaultBusinessDocSettings(doc));

  // Currency: ensure the engine always has a symbol to render.
  // Priority: caller-set currency_symbol_override > ISO currency code on the doc.
  const rs: Record<string, unknown> = { ...baseRs };
  if (
    !rs.currency_symbol_override
    && typeof doc.currency === "string"
    && doc.currency.trim().length > 0
  ) {
    rs.currency_symbol_override = doc.currency.trim();
    if (!rs.currency_display) rs.currency_display = "symbol";
  }

  const org = doc.organization ?? {};
  const org_ = org as unknown as Record<string, unknown>;

  const items: ReceiptItemLike[] = (doc.items ?? []).map((i) => ({
    product_name:
      (i as unknown as { product_name?: string }).product_name
      ?? i.description
      ?? (i as unknown as { name?: string }).name
      ?? "Item",
    sku: (i as unknown as { sku?: string | null }).sku ?? null,
    quantity: Number(i.quantity ?? 0),
    unit_price: Number(i.unit_price ?? 0),
    discount_amount: Number(i.discount_amount ?? 0),
    line_total: Number(i.line_total ?? 0),
    tax_rate: (i as unknown as { tax_rate?: number | null }).tax_rate ?? null,
    tax_amount: (i as unknown as { tax_amount?: number | null }).tax_amount ?? null,
    tax_rate_name:
      (i as unknown as { tax_rate_name?: string | null }).tax_rate_name ?? null,
  }));

  const payments: ReceiptPaymentLike[] = (doc.pos_payments ?? []).map((p) => ({
    payment_method: p.payment_method,
    amount: Number(p.amount ?? 0),
    reference: p.reference ?? null,
  }));

  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const change = Math.max(0, totalPaid - Number(doc.total ?? 0));

  // Recipient labelling: invoices bill, POs vendor, delivery notes ship, etc.
  const recipientLabel =
    doc.document_type === "purchase_order" ? "Vendor"
    : doc.document_type === "delivery_note" ? "Deliver To"
    : doc.document_type === "estimate" || doc.document_type === "proforma"
      ? "Quote For"
    : isPos ? "Customer"
    : "Bill To";

  const billTo = contactToRecipient(doc.contact, recipientLabel);
  const shipTo = doc.shipping_address
    ? {
        label: "Ship To",
        name: doc.contact?.name ?? null,
        address_lines: [doc.shipping_address],
      } as ReceiptRecipientLike
    : null;

  const resolvedTitle = overrides.title
    ?? doc.document_type_label
    ?? TITLE_BY_TYPE[doc.document_type]
    ?? doc.document_type.toUpperCase();

  const transaction: ReceiptTransactionLike = {
    id: doc.document_number,
    transaction_number: doc.document_number,
    created_at: doc.issue_date,
    subtotal: Number(doc.subtotal ?? 0),
    tax_amount: Number(doc.tax_amount ?? 0),
    discount_amount: Number(doc.discount_amount ?? 0),
    total_amount: Number(doc.total ?? 0),
    amount_tendered: isPos && totalPaid > 0 ? totalPaid : undefined,
    change_due: isPos && change > 0 ? change : undefined,
    customer_name: isPos
      ? (doc.contact?.name ?? doc.contact?.company ?? null)
      : null,
    cashier_name: doc.cashier_name ?? null,
    register_id: doc.register_name ?? doc.register_id ?? null,
    items,
    payments: isPos ? payments : [],
    etims_cu_number: isPos ? (doc.etims_cu_number ?? null) : null,
    etims_qr_data: isPos ? (doc.etims_qr_data ?? null) : null,
    title: resolvedTitle,
    bill_to: isPos ? null : billTo,
    ship_to: isPos ? null : shipTo,
    due_date: !isPos ? (doc.due_date ?? null) : null,
    status: !isPos ? (doc.status ?? null) : null,
    notes: !isPos ? (doc.notes ?? null) : null,
    terms: !isPos ? (doc.terms ?? null) : null,
    currency_code: typeof doc.currency === "string" ? doc.currency : null,
  };

  return {
    settings: rs,
    company: {
      name: (org_.name as string) ?? "",
      logo_url: (org_.logo_url as string) ?? null,
      address:
        overrides.companyExtras?.address
        ?? (org_.address as string)
        ?? null,
      city: overrides.companyExtras?.city ?? (org_.city as string) ?? null,
      phone: overrides.companyExtras?.phone ?? (org_.phone as string) ?? null,
      email: overrides.companyExtras?.email ?? (org_.email as string) ?? null,
      tax_id: (org_.tax_id as string) ?? null,
    },
    transaction,
  };
}
