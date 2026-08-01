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
import { mergeReceiptSettings } from "@/lib/pos/mergeReceiptSettings";
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

/**
 * Field aliasing for the frozen `pos_receipt_snapshots.payload.transaction`
 * row, which is a verbatim `pos_transactions` record (`subtotal`, `total`,
 * `transaction_number`, `created_at`) rather than the `*_amount` naming this
 * builder originally assumed. Reading the wrong key silently produced
 * `Subtotal 0.00 / TOTAL 0.00` on printed receipts.
 */
function pick<T = unknown>(row: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

export function buildPosReceiptSnapshot(
  input: BuildPosReceiptSnapshotInput,
): BuildPosReceiptSnapshotResult {
  const { frozen, copy = "customer" } = input;
  const txn = (frozen.transaction ?? {}) as Record<string, unknown>;
  // Company-level settings are canonical; the register row may only override
  // the terminal-scoped whitelist. Same resolver the POS preview uses.
  const receiptSettings = mergeReceiptSettings(
    frozen.business_receipt_settings ?? null,
    frozen.register_receipt_settings ?? null,
  );

  const documentNumber =
    pick<string>(txn, "transaction_number", "receipt_number") ?? null;
  const issuedAt =
    pick<string>(txn, "completed_at", "transacted_at", "created_at") ?? null;

  // Derived safety net: a frozen payload must never print "Subtotal 0.00"
  // while items and payments carry money. If the transaction row is missing
  // (or renames) its money columns, fall back to the item lines — the same
  // arithmetic the on-screen preview performs.
  const itemsSum = (frozen.items ?? []).reduce(
    (s, it) => s + numeric(it.line_total ?? it.total),
    0,
  );
  const paymentsSum = (frozen.payments ?? []).reduce(
    (s, p) => s + numeric(p.amount),
    0,
  );
  const taxAmount = numeric(pick(txn, "tax_amount"));
  const discountAmount = numeric(pick(txn, "discount_amount"));
  const subtotal = numeric(pick(txn, "subtotal", "subtotal_amount")) || itemsSum;
  const total =
    numeric(pick(txn, "total", "total_amount"))
    || subtotal + taxAmount - discountAmount
    || paymentsSum;

  const snapshot: SnapshotBlob = {
    document_type: "pos_receipt",
    document_type_label:
      copy === "merchant" ? "MERCHANT COPY" : "SALES RECEIPT",
    document_number: documentNumber,
    issue_date: issuedAt,
    status: pick<string>(txn, "status") ?? "PAID",
    currency: pick<string>(txn, "currency") ?? null,
    subtotal,
    tax_amount: taxAmount,
    discount_amount: discountAmount,
    total,
    amount_paid: numeric(pick(txn, "amount_paid")) || paymentsSum,
    change_due: numeric(pick(txn, "change_due")),

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
    pos_receipt_settings: receiptSettings as unknown as Record<string, unknown>,
    cashier_name: frozen.cashier?.name ?? null,
    register_id: frozen.register?.code ?? frozen.register?.id ?? null,
    notes: (pick<string>(txn, "notes") as string | undefined) ?? null,
    etims_cu_number: pick<string>(txn, "etims_cu_number") ?? null,
    etims_qr_data: pick<string>(txn, "etims_qr_data") ?? null,
  };

  return {
    snapshot,
    documentNumber,
    documentDate: isoDate(issuedAt ?? undefined),
    currency: pick<string>(txn, "currency") ?? null,
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
