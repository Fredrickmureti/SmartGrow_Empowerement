/**
 * POS receipt UI model (client-side, on-screen only).
 *
 * Role boundary — read this before adding a caller:
 *   • `ReceiptDocumentModel` is the **UI/customer-display shape** for the
 *     POS surfaces (TransactionSummaryView, ReceiptPreviewDialog,
 *     PostPaymentScreen) and the second-screen `CustomerDisplayRenderer`.
 *     It is built from either a frozen `pos_receipt_snapshots.payload`
 *     or the live in-memory transaction.
 *   • `DocumentData` (server, `supabase/functions/_shared/templateRenderer.ts`)
 *     is the **canonical print shape**. Every printed / emitted receipt
 *     — thermal PDF, ESC/POS bytes, kitchen ticket, invoice, statement —
 *     is produced from `DocumentData` via `documentToReceiptInput` +
 *     `buildReceiptLines`. The server refetches from the snapshot on
 *     print by design (tamper resistance, single source of truth).
 *
 * These two shapes intentionally exist in parallel today. The
 * consolidation target (`.lovable/plan.md` Phase 3, item 7) is a
 * one-way collapse: introduce a client mirror of `DocumentData`, add a
 * `receiptModelToDocumentData()` adapter, migrate the four POS surfaces,
 * and delete this file. Do NOT reintroduce this shape into the print or
 * ESC/POS pipeline in the meantime — that path stays canonical.
 *
 * The `pos-receipt-model-boundary` architecture test enforces the second
 * invariant (no print/ESC/POS/PDF code may import `ReceiptDocumentModel`).
 */
import type { POSReceiptSnapshot } from "@/hooks/pos/useReceiptSnapshot";
import type { ExtendedReceiptSettings } from "@/types/receipt";
import { mergeReceiptSettings } from "@/lib/pos/mergeReceiptSettings";
import { DEFAULT_EXTENDED_RECEIPT_SETTINGS } from "@/lib/receiptConfig";
import { resolveReceiptTitle } from "@/lib/pos/resolveReceiptTitle";

function isEmptyObject(v: unknown): boolean {
  return !v || (typeof v === "object" && Object.keys(v as object).length === 0);
}

export interface ReceiptDocumentItem {
  product_name: string;
  sku?: string | null;
  /** Base-unit quantity (what the ledger debits). Always populated. */
  quantity: number;
  unit_price: number;
  discount_amount?: number;
  line_total: number;
  /** Display-unit quantity (the count of `packaging_label` the user transacted). */
  display_quantity?: number | null;
  /** Short pack label, e.g. "Box". When null we render the base unit only. */
  packaging_label?: string | null;
  /** Short base UoM label, e.g. "ea" / "tab". Defaults to "ea" at render time. */
  base_uom_label?: string | null;
  /** Frozen snapshot string (e.g. "Box × 10 ea") — used by audit views. */
  uom_snapshot?: string | null;
}

export interface ReceiptDocumentPayment {
  payment_method: string;
  /** Amount applied to the invoice. */
  amount: number;
  /** Tender presented (cash bills given). Defaults to `amount` for non-cash. */
  tendered_amount?: number;
  /** Cash change returned to the customer; 0 for non-cash. */
  change_given?: number;
  reference?: string | null;
}

export interface ReceiptDocumentHeader {
  business_name: string;
  logo_url: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  tax_id: string | null;
  header_text: string | null;
}

export interface ReceiptDocumentMeta {
  transaction_id: string;
  transaction_number: string;
  created_at: string;
  customer_name: string | null;
  cashier_name: string | null;
  register_id: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  etims_cu_number: string | null;
  etims_qr_data: string | null;
  /** Resolved professional POS title — SALES RECEIPT / TAX INVOICE /
   *  INVOICE / CREDIT NOTE (+ VOID / REPRINT decoration). Single source of
   *  truth shared with the ESC/POS builder so screen and paper agree. */
  title: string;
}

export interface ReceiptDocumentTotals {
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total_amount: number;
  /** sum(payments) - total_amount, clamped at >= 0 */
  change_due: number;
  /** sum(payments) — useful for split-tender confirmation */
  amount_tendered: number;
}

export interface ReceiptDocumentFlags {
  is_voided: boolean;
  is_refund: boolean;
  /** Set true by reprint surfaces; renderers stamp a REPRINT watermark. */
  is_reprint: boolean;
  /** Sale committed offline and pending sync. UI-only badge. */
  is_offline: boolean;
}

export interface ReceiptDocumentModel {
  meta: ReceiptDocumentMeta;
  header: ReceiptDocumentHeader;
  items: ReceiptDocumentItem[];
  totals: ReceiptDocumentTotals;
  payments: ReceiptDocumentPayment[];
  footer_text: string | null;
  return_policy_text: string | null;
  flags: ReceiptDocumentFlags;
  /** Effective receipt settings for renderers (visibility toggles, format). */
  settings: ExtendedReceiptSettings;
}

/** Live-transaction shape passed in from POSTerminal/ReceiptPreviewDialog. */
export interface LiveTransactionInput {
  id: string;
  transaction_number: string;
  total_amount: number;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  created_at: string;
  payment_method?: string;
  customer_name?: string | null;
  cashier_name?: string | null;
  register_id?: string | null;
  invoice_id?: string | null;
  invoice_number?: string | null;
  etims_cu_number?: string | null;
  etims_qr_data?: string | null;
  items: ReceiptDocumentItem[];
  payments: ReceiptDocumentPayment[];
  is_voided?: boolean;
  is_refund?: boolean;
  is_offline?: boolean;
}

export interface BuildOptions {
  /** When the snapshot is loaded, prefer it. Otherwise fall back to live. */
  snapshot?: POSReceiptSnapshot | null;
  /** Live transaction shape (always required as fallback). */
  live: LiveTransactionInput;
  /** Live receipt settings used when snapshot is absent. */
  liveSettings: ExtendedReceiptSettings;
  /** Live branding (currentBusiness/currentBranch) used when snapshot is absent. */
  liveBranding: Partial<ReceiptDocumentHeader>;
  /** Mark this render as a reprint — stamps a watermark. */
  isReprint?: boolean;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/**
 * Build a normalized model from snapshot (preferred) or live data.
 * Pure function — safe to call inside renderers and unit tests.
 */
export function buildReceiptDocument(opts: BuildOptions): ReceiptDocumentModel {
  const { snapshot, live, liveSettings, liveBranding, isReprint } = opts;

  // Resolve effective settings — snapshot has business+register pair stored
  // raw so we re-merge identically to runtime.
  //
  // Bug 2 fix: when the snapshot stored both settings rows as null/empty
  // (the per-business `receipt_settings` column was introduced after some
  // tenants had already started transacting), `mergeReceiptSettings(null,
  // null)` collapses every `show_*` flag to falsy, which produces a receipt
  // preview that strips qty / payments / eTIMS / subtotal. Cascade through
  // live settings, then DEFAULT_EXTENDED_RECEIPT_SETTINGS, so the renderer
  // always has a usable visibility profile.
  let settings: ExtendedReceiptSettings;
  if (snapshot && (!isEmptyObject(snapshot.business_receipt_settings) || !isEmptyObject(snapshot.register_receipt_settings))) {
    settings = mergeReceiptSettings(
      snapshot.business_receipt_settings as Partial<ExtendedReceiptSettings> | null,
      snapshot.register_receipt_settings as Partial<ExtendedReceiptSettings> | null,
    );
  } else if (liveSettings && Object.keys(liveSettings).length > 0) {
    settings = { ...DEFAULT_EXTENDED_RECEIPT_SETTINGS, ...liveSettings };
  } else {
    settings = DEFAULT_EXTENDED_RECEIPT_SETTINGS;
  }

  // Header — snapshot wins field-by-field; live branding fills the gaps.
  const snapBiz = (snapshot?.business ?? {}) as Record<string, unknown>;
  const snapBranch = (snapshot?.branch ?? {}) as Record<string, unknown>;
  const header: ReceiptDocumentHeader = {
    business_name:
      str(snapBiz.name) ?? liveBranding.business_name ?? "Store",
    logo_url: str(snapBiz.logo_url) ?? liveBranding.logo_url ?? null,
    address:
      str(snapBranch.address) ?? str(snapBiz.address) ?? liveBranding.address ?? null,
    city: str(snapBranch.city) ?? str(snapBiz.city) ?? liveBranding.city ?? null,
    phone: str(snapBranch.phone) ?? str(snapBiz.phone) ?? liveBranding.phone ?? null,
    email: str(snapBiz.email) ?? liveBranding.email ?? null,
    tax_id: str(snapBiz.tax_id) ?? liveBranding.tax_id ?? null,
    header_text: str(settings.receipt_header),
  };

  // Meta (title resolved after totals/payments/flags are known)
  const snapTxn = (snapshot?.transaction ?? {}) as Record<string, unknown>;
  const snapCashier = snapshot?.cashier;
  const snapCustomer = (snapshot?.customer ?? {}) as Record<string, unknown>;

  // Items + payments — snapshot arrays win when present.
  const items: ReceiptDocumentItem[] = (snapshot?.items?.length
    ? snapshot.items.map((i) => {
        const r = i as Record<string, unknown>;
        return {
          product_name:
            str(r.product_name) ??
            str(r.description) ??
            str(r.name) ??
            "Item",
          sku: str(i.sku),
          quantity: num(i.quantity),
          unit_price: num(i.unit_price),
          discount_amount: num(i.discount_amount, 0),
          line_total: num(i.line_total),
          display_quantity: r.display_quantity == null ? null : num(r.display_quantity),
          packaging_label: str(r.packaging_label),
          base_uom_label: str(r.base_uom_label),
          uom_snapshot: str(r.uom_snapshot),
        } satisfies ReceiptDocumentItem;
      })
    : live.items);

  const payments: ReceiptDocumentPayment[] = (snapshot?.payments?.length
    ? snapshot.payments.map((p) => ({
        payment_method: str(p.payment_method) ?? "cash",
        amount: num(p.amount),
        reference: str(p.reference),
        tendered_amount: num((p as Record<string, unknown>).tendered_amount, num(p.amount)),
        change_given: num((p as Record<string, unknown>).change_given, 0),
      }))
    : live.payments.map((p) => ({
        ...p,
        tendered_amount: p.tendered_amount ?? p.amount,
        change_given: p.change_given ?? 0,
      })));

  // Totals — always from canonical txn numbers; tender/change reflect what
  // the customer actually presented (cash bills handed over) rather than
  // the allocated invoice amount, so on-screen and printed receipts now
  // agree on the 20,000-cash / 19,000-sale case.
  const total_amount = num(snapTxn.total_amount, live.total_amount);
  const actualPaid = payments
    .filter((p) => p.payment_method !== "credit")
    .reduce((acc, p) => acc + p.amount, 0);
  const sumTendered = payments.reduce((acc, p) => acc + (p.tendered_amount ?? p.amount), 0);
  const sumChange = payments.reduce((acc, p) => acc + (p.change_given ?? 0), 0);
  const totals: ReceiptDocumentTotals = {
    subtotal: num(snapTxn.subtotal, live.subtotal),
    discount_amount: num(snapTxn.discount_amount, live.discount_amount),
    tax_amount: num(snapTxn.tax_amount, live.tax_amount),
    total_amount,
    amount_tendered: sumTendered,
    change_due: sumChange > 0 ? sumChange : Math.max(0, sumTendered - total_amount),
  };

  const flags: ReceiptDocumentFlags = {
    is_voided: Boolean(snapTxn.is_voided ?? live.is_voided ?? false),
    is_refund: Boolean(snapTxn.is_refund ?? live.is_refund ?? false),
    is_reprint: Boolean(isReprint ?? false),
    is_offline: Boolean(live.is_offline ?? false),
  };

  const etimsCu = str(snapTxn.etims_cu_number) ?? str(live.etims_cu_number);
  const resolvedTitle = resolveReceiptTitle({
    total: total_amount,
    amount_paid: actualPaid,
    payments: payments.map((p) => ({ payment_method: p.payment_method, amount: p.amount })),
    tax_amount: totals.tax_amount,
    etims_cu_number: etimsCu,
    is_voided: flags.is_voided,
    is_refund: flags.is_refund,
    is_reprint: flags.is_reprint,
    legacy_title_mode: !!(settings as { legacy_title_mode?: boolean }).legacy_title_mode,
  });

  const meta: ReceiptDocumentMeta = {
    transaction_id: live.id,
    transaction_number: str(snapTxn.transaction_number) ?? live.transaction_number,
    created_at: str(snapTxn.created_at) ?? live.created_at,
    customer_name:
      str(snapCustomer.name) ?? str(live.customer_name) ?? null,
    cashier_name:
      str(snapCashier?.name) ?? str(live.cashier_name) ?? null,
    register_id: str(snapTxn.register_id) ?? str(live.register_id),
    invoice_id: str(snapTxn.invoice_id) ?? str(live.invoice_id),
    invoice_number: str(snapTxn.invoice_number) ?? str(live.invoice_number),
    etims_cu_number: etimsCu,
    etims_qr_data: str(snapTxn.etims_qr_data) ?? str(live.etims_qr_data),
    title: resolvedTitle.title,
  };

  return {
    meta,
    header,
    items,
    totals,
    payments,
    footer_text: str(settings.receipt_footer),
    return_policy_text: settings.show_return_policy
      ? str(settings.return_policy_text)
      : null,
    flags,
    settings,
  };
}