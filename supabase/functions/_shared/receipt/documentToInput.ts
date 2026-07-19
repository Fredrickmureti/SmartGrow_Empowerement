/**
 * Adapter: `DocumentData` (fetcher output) → `BuildReceiptLinesInput`
 * (engine input). This is the ONLY place that translates fetcher fields
 * into the receipt engine's row producer.
 */

import type { DocumentData } from "../templateRenderer.ts";
import type {
  BuildReceiptLinesInput,
  ReceiptItemLike,
  ReceiptPaymentLike,
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

export function documentToReceiptInput(
  doc: DocumentData,
  overrides: DocToInputOverrides = {},
): BuildReceiptLinesInput {
  const rs = (overrides.settings
    ?? (doc as unknown as { pos_receipt_settings?: Record<string, unknown> })
      .pos_receipt_settings
    ?? {}) as Record<string, unknown>;

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

  const transaction: ReceiptTransactionLike = {
    id: doc.document_number,
    transaction_number: doc.document_number,
    created_at: doc.issue_date,
    subtotal: Number(doc.subtotal ?? 0),
    tax_amount: Number(doc.tax_amount ?? 0),
    discount_amount: Number(doc.discount_amount ?? 0),
    total_amount: Number(doc.total ?? 0),
    amount_tendered: totalPaid > 0 ? totalPaid : undefined,
    change_due: change > 0 ? change : undefined,
    customer_name: doc.contact?.name ?? doc.contact?.company ?? null,
    cashier_name: doc.cashier_name ?? null,
    register_id: doc.register_name ?? doc.register_id ?? null,
    items,
    payments,
    etims_cu_number: doc.etims_cu_number ?? null,
    etims_qr_data: doc.etims_qr_data ?? null,
    title: overrides.title ?? doc.document_type_label,
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