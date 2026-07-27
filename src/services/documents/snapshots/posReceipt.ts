/**
 * Wave 7.1.5 — POS customer receipt snapshot builder.
 *
 * Converts a `pos_receipt_snapshots.payload` row (frozen by the
 * `_pos_write_receipt_snapshot` AFTER INSERT trigger) into the JSON blob the
 * shared renderer expects for `document_kinds.code = 'pos.receipt_customer'`.
 *
 * The shape mirrors the fixture locked by
 * `supabase/functions/_shared/rendering/renderers/thermal_receipt_golden_test.ts`
 * — additions here must land alongside a matching golden bump.
 */
import type { POSReceiptSnapshot } from "@/hooks/pos/useReceiptSnapshot";
import type { SnapshotBlob } from "./index";

export interface BuildPosReceiptSnapshotInput {
  frozen: POSReceiptSnapshot;
  /** `customer` | `merchant` copy — controls the printed heading. */
  copy?: "customer" | "merchant";
}

export interface BuildPosReceiptSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string | null;
  documentDate: string | null;
  currency: string | null;
  partyId: string | null;
  partyKind: "customer" | null;
  businessId: string | null;
  branchId: string | null;
}

export function buildPosReceiptSnapshot(
  input: BuildPosReceiptSnapshotInput,
): BuildPosReceiptSnapshotResult {
  const { frozen, copy = "customer" } = input;
  const txn = frozen.transaction ?? {};
  const receiptSettings =
    frozen.register_receipt_settings ?? frozen.business_receipt_settings ?? {};

  const snapshot: SnapshotBlob = {
    document_type: "pos_receipt",
    document_type_label:
      copy === "merchant" ? "MERCHANT COPY" : "SALES RECEIPT",
    document_number: (txn.receipt_number as string | undefined) ?? null,
    issue_date: (txn.transacted_at as string | undefined) ?? null,
    status: (txn.status as string | undefined) ?? "PAID",
    currency: (txn.currency as string | undefined) ?? null,
    subtotal: numeric(txn.subtotal_amount),
    tax_amount: numeric(txn.tax_amount),
    discount_amount: numeric(txn.discount_amount),
    total: numeric(txn.total_amount),
    amount_paid: numeric(txn.amount_paid),
    change_due: numeric(txn.change_due),
    contact: frozen.customer
      ? {
          id: frozen.customer.id ?? null,
          name: frozen.customer.name ?? frozen.customer.display_name ?? null,
          email: frozen.customer.email ?? null,
          phone: frozen.customer.phone ?? null,
        }
      : null,
    items: (frozen.items ?? []).map((it) => ({
      description: it.description ?? it.product_name ?? "",
      quantity: numeric(it.quantity),
      unit_price: numeric(it.unit_price),
      line_total: numeric(it.line_total ?? it.total),
      tax_amount: numeric(it.tax_amount),
      tax_rate: numeric(it.tax_rate),
    })),
    pos_payments: (frozen.payments ?? []).map((p) => ({
      payment_method: p.payment_method ?? p.method ?? null,
      amount: numeric(p.amount),
      reference: p.reference ?? null,
    })),
    pos_receipt_settings: receiptSettings,
    cashier_name: frozen.cashier?.name ?? null,
    register_id: frozen.register?.code ?? frozen.register?.id ?? null,
    notes: (txn.notes as string | undefined) ?? null,
    etims_cu_number: (txn.etims_cu_number as string | undefined) ?? null,
    etims_qr_data: (txn.etims_qr_data as string | undefined) ?? null,
  };

  return {
    snapshot,
    documentNumber: (txn.receipt_number as string | undefined) ?? null,
    documentDate: isoDate(txn.transacted_at as string | undefined),
    currency: (txn.currency as string | undefined) ?? null,
    partyId: (frozen.customer?.id as string | undefined) ?? null,
    partyKind: frozen.customer ? "customer" : null,
    businessId: (frozen.business?.id as string | undefined) ?? null,
    branchId: (frozen.branch?.id as string | undefined) ?? null,
  };
}

function numeric(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isoDate(ts: string | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
