/**
 * Server-side `buildReceiptLines` — deno mirror of
 * `src/lib/receipt/preview/buildReceiptLines.ts`. Produces the exact same
 * padded string rows + `LineMeta[]` intermediate representation that the
 * on-screen monospace preview consumes.
 *
 * This is the single flow-based row producer for a POS receipt. Two
 * targets consume its output:
 *   - `renderThermalPdf(...)` (this package) — for PDF export / email /
 *     archive at 40/58/80 mm.
 *   - The on-screen `MonospacePreview` (client) — via its client twin.
 *
 * NOT covered here: ESC/POS byte emission — `builder.ts` still owns that
 * (byte-golden tests). A follow-up will merge them so this file becomes
 * the sole DocumentData → row translator for every target.
 */

import {
  contentWidth,
  resolvePrinterProfile,
  type Font,
  type PaperWidth,
} from "./engine/PrinterProfile.ts";
import { padLR, wordWrap } from "./engine/ColumnLayout.ts";
import {
  LAYOUT_REGISTRY,
  pickFittingLayout,
  resolveLegacyLayout,
} from "./layouts/index.ts";
import { assembleItems } from "./items.ts";

export type LineAlign = "left" | "center" | "right";

export interface LineMeta {
  align: LineAlign;
  bold?: boolean;
  large?: boolean;
  /** Horizontal rule (a `-` line). Renderers may style subtly. */
  rule?: boolean;
  /** Native-QR placeholder row (renderers substitute their own QR). */
  qr?: boolean;
}

export interface ReceiptLinesResult {
  /** Rows already padded to `profile.columns` for left-aligned rows;
   * centred/right rows are un-padded so renderers can centre inside `columns`. */
  lines: string[];
  meta: LineMeta[];
  columns: number;
  marginCols: number;
  paper: PaperWidth;
  font: Font;
  /** Optional QR payload the renderer should draw when a `qr:true` row is emitted. */
  qrPayload?: string;
}

// deno-lint-ignore no-explicit-any
type Rs = Record<string, any>;

export interface ReceiptCompanyLike {
  name?: string | null;
  logo_url?: string | null;
  address?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  tax_id?: string | null;
}

export interface ReceiptItemLike {
  product_name?: string;
  description?: string;
  name?: string;
  sku?: string | null;
  quantity: number;
  unit_price: number;
  discount_amount?: number;
  line_total: number;
  tax_rate?: number | null;
  tax_amount?: number | null;
  tax_rate_name?: string | null;
  modifiers?: Array<{ name: string; amount?: number }>;
  notes?: string | null;
}

export interface ReceiptPaymentLike {
  payment_method: string;
  amount: number;
  reference?: string | null;
}

export interface ReceiptRecipientLike {
  label?: string;               // "Bill To" | "Customer" | "Ship To"
  name?: string | null;
  company?: string | null;
  address_lines?: Array<string | null | undefined>;
  phone?: string | null;
  email?: string | null;
  tax_id?: string | null;
}

export interface ReceiptTransactionLike {
  id?: string;
  transaction_number?: string;
  created_at?: string;
  subtotal?: number;
  tax_amount?: number;
  discount_amount?: number;
  total_amount: number;
  amount_tendered?: number;
  change_due?: number;
  customer_name?: string | null;
  cashier_name?: string | null;
  register_id?: string | null;
  items: ReceiptItemLike[];
  payments: ReceiptPaymentLike[];
  etims_cu_number?: string | null;
  etims_qr_data?: string | null;
  /** Optional resolved title, e.g. "SALES RECEIPT" / "TAX INVOICE" / "REFUND". */
  title?: string;
  // ── Non-POS document extras (invoice / quote / PO / delivery note) ──
  /** Structured recipient block. Rendered as a labelled address block. */
  bill_to?: ReceiptRecipientLike | null;
  ship_to?: ReceiptRecipientLike | null;
  /** Due date, already formatted or ISO — engine reformats when ISO. */
  due_date?: string | null;
  /** Human status label (e.g. "COMPLETED", "OVERDUE"). */
  status?: string | null;
  /** Free-form notes block. */
  notes?: string | null;
  /** Terms & conditions block. */
  terms?: string | null;
  /** Currency ISO code (KES, USD…). Adapter passes this so engine can fall
   * back to a code prefix when no symbol override is configured. */
  currency_code?: string | null;
}

export interface BuildReceiptLinesInput {
  settings: Rs;
  company: ReceiptCompanyLike;
  transaction: ReceiptTransactionLike;
}

function fmtNumber(n: number, decimals = 2, thousands = ","): string {
  const v = Number.isFinite(n) ? n : 0;
  const fixed = v.toFixed(Math.max(0, Math.min(4, decimals)));
  if (!thousands) return fixed;
  const [intPart, fracPart] = fixed.split(".");
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  return fracPart != null ? `${withSep}.${fracPart}` : withSep;
}

function fmtQty(n: number): string {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 4) return s.slice(0, max);
  return s.slice(0, max - 1) + "…";
}

function fmtDateTime(iso: string, dateFormat = "iso", timeFormat = "24h"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  const h24 = d.getHours();
  const mi = d.getMinutes();
  const monthShort = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][mo - 1];
  let datePart: string;
  switch (dateFormat) {
    case "dmy": datePart = `${pad2(da)}/${pad2(mo)}/${y}`; break;
    case "mdy": datePart = `${pad2(mo)}/${pad2(da)}/${y}`; break;
    case "long": datePart = `${pad2(da)} ${monthShort} ${y}`; break;
    default: datePart = `${y}-${pad2(mo)}-${pad2(da)}`;
  }
  if (timeFormat === "none") return datePart;
  if (timeFormat === "12h") {
    const am = h24 < 12;
    const h12 = ((h24 + 11) % 12) + 1;
    return `${datePart} ${pad2(h12)}:${pad2(mi)} ${am ? "AM" : "PM"}`;
  }
  return `${datePart} ${pad2(h24)}:${pad2(mi)}`;
}

export function buildReceiptLines(input: BuildReceiptLinesInput): ReceiptLinesResult {
  const { settings: rs, company, transaction: t } = input;

  const paper: PaperWidth =
    rs.paper_size === "40mm" ? "40mm" : rs.paper_size === "58mm" ? "58mm" : "80mm";
  const font: Font = rs.font_size === "small" ? "B" : "A";
  const profile = resolvePrinterProfile({
    paper,
    font,
    marginCols: typeof rs.margin_cols === "number" ? rs.margin_cols : undefined,
    columnsOverride: typeof rs.columns_override === "number" ? rs.columns_override : undefined,
  });
  const cols = profile.columns;
  const marginCols = profile.marginCols;
  const cw = contentWidth(profile);
  const marginPad = " ".repeat(marginCols);

  const lines: string[] = [];
  const meta: LineMeta[] = [];

  const push = (text: string, m: LineMeta) => {
    if (m.align === "left") {
      const content = text.length > cw ? text.slice(0, cw - 1) + "\u2026" : text;
      lines.push(marginPad + content);
    } else {
      lines.push(text.length > cols ? text.slice(0, cols - 1) + "\u2026" : text);
    }
    meta.push(m);
  };
  const left = (s = "") => push(s, { align: "left" });
  const center = (s: string, opts: { bold?: boolean; large?: boolean } = {}) =>
    push(s, { align: "center", ...opts });
  const blank = () => push("", { align: "left" });
  const rule = (ch = "-") => push(ch.repeat(cw), { align: "left", rule: true });

  const decimals = typeof rs.decimal_places === "number" ? rs.decimal_places : 2;
  const thousands = (rs.thousands_separator ?? ",") as string;
  const currencyCode = (t.currency_code ?? "").toString().trim();
  const fmtCur = (n: number) => {
    const num = fmtNumber(Number(n ?? 0), decimals, thousands);
    const explicitSym = typeof rs.currency_symbol_override === "string"
      ? rs.currency_symbol_override.trim()
      : "";
    // Priority: explicit symbol > ISO code prefix (invoice/PO fallback) > none
    const sym = explicitSym || currencyCode;
    if (rs.currency_display === "none") return num;
    if (!sym) return num;
    return rs.currency_position === "after" ? `${num} ${sym}` : `${sym} ${num}`;
  };
  const fmtMoney = (n: number) => fmtNumber(Number(n ?? 0), decimals, thousands);

  // ── Header ──────────────────────────────────────────────────────────
  if (rs.show_logo && company.logo_url) center("[ logo ]");
  if (rs.show_store_name !== false) {
    center(truncate(company.name ?? "", cw), {
      bold: true,
      large: rs.font_size === "large",
    });
  }
  if (rs.show_store_address && company.address) {
    for (const l of wordWrap(company.address, cw)) center(l);
    if (company.city) center(truncate(company.city, cw));
  }
  if (rs.show_store_phone && company.phone) center(truncate(company.phone, cw));
  if (rs.show_store_email && company.email) center(truncate(company.email, cw));
  if (typeof rs.receipt_header === "string" && rs.receipt_header) {
    for (const l of wordWrap(rs.receipt_header, cw)) center(l);
  }
  rule();

  // ── Title + meta ────────────────────────────────────────────────────
  const resolvedTitle = t.title ?? "RECEIPT";
  center(resolvedTitle, { bold: true });
  // Refund banner (Wave 6b.2) — a negative total OR an explicit refund
  // title (REFUND / RETURN / CREDIT NOTE) surfaces a bold banner so the
  // customer and cashier immediately see this is not a normal sale.
  const isRefundDoc =
    /REFUND|RETURN|CREDIT\s*NOTE/i.test(resolvedTitle) ||
    Number(t.total_amount ?? 0) < 0;
  if (isRefundDoc) {
    blank();
    center("*** REFUND ***", { bold: true });
    blank();
  }

  if (rs.show_receipt_number !== false && t.transaction_number) {
    left(padLR("No:", t.transaction_number, cw));
  }
  if (rs.show_date_time !== false && t.created_at) {
    left(padLR("Date:", fmtDateTime(t.created_at, rs.date_format, rs.time_format), cw));
  }
  if (t.due_date) {
    const dueLabel = /^\d{4}-\d{2}-\d{2}/.test(t.due_date)
      ? fmtDateTime(t.due_date, rs.date_format, "none")
      : t.due_date;
    left(padLR("Due:", dueLabel, cw));
  }
  if (t.status && rs.show_status !== false) {
    left(padLR("Status:", String(t.status).toUpperCase(), cw));
  }
  if (rs.show_cashier_name && t.cashier_name) {
    const label = rs.cashier_label_format === "served_by" ? "Served by:" : "Cashier:";
    left(padLR(label, t.cashier_name, cw));
  }
  if (rs.show_register_id && t.register_id) {
    left(padLR("Register:", t.register_id, cw));
  }
  if (rs.show_customer_name && t.customer_name) {
    left(padLR("Customer:", t.customer_name, cw));
  }

  // ── Recipient block (Bill To / Ship To) ─────────────────────────────
  const emitRecipient = (r: ReceiptRecipientLike | null | undefined) => {
    if (!r) return;
    const parts: string[] = [];
    const primary = r.name || r.company;
    if (primary) parts.push(primary);
    if (r.name && r.company && r.company !== r.name) parts.push(r.company!);
    for (const l of r.address_lines ?? []) {
      if (l && String(l).trim()) parts.push(String(l).trim());
    }
    if (r.phone) parts.push(`Tel: ${r.phone}`);
    if (r.email) parts.push(r.email);
    if (r.tax_id) parts.push(`Tax ID: ${r.tax_id}`);
    if (parts.length === 0) return;
    blank();
    left(`${r.label ?? "Bill To"}:`);
    for (const p of parts) {
      for (const l of wordWrap(p, cw - 2)) left("  " + l);
    }
  };
  emitRecipient(t.bill_to);
  if (t.ship_to && (t.ship_to.address_lines?.some((l) => l && String(l).trim()) || t.ship_to.name)) {
    emitRecipient(t.ship_to);
  }
  rule();

  // ── Items ───────────────────────────────────────────────────────────
  const preferredLayoutId = resolveLegacyLayout(
    rs.item_display_format,
    !!rs.show_item_sku,
  );
  const ctx = {
    showSku: !!rs.show_item_sku,
    showQty: rs.show_item_quantity !== false,
    showUnitPrice: rs.show_unit_price !== false,
    showDiscount: !!rs.show_item_discount,
    showTaxBreakdown: !!rs.show_tax_breakdown,
    showTaxRate: !!rs.show_tax_rate,
    showModifiers: rs.show_item_modifiers !== false,
    truncateLongNames: !!rs.truncate_long_names,
    maxNameLen: typeof rs.max_item_name_length === "number" ? rs.max_item_name_length : 28,
  };
  void LAYOUT_REGISTRY;
  const { layoutId } = pickFittingLayout(preferredLayoutId, ctx, cw);
  const assembled = assembleItems({
    items: (t.items ?? []) as unknown as Parameters<typeof assembleItems>[0]["items"],
    layoutId,
    ctx,
    contentWidth: cw,
    fmt: { fmtMoney, fmtQty, truncate },
  });
  for (const row of assembled.rows) {
    if (row.kind === "heading" || row.kind === "header") {
      push(row.text, { align: "left", bold: !!row.bold });
    } else {
      push(row.text, { align: "left" });
    }
  }
  rule();

  // ── Totals ──────────────────────────────────────────────────────────
  if (rs.show_subtotal !== false && t.subtotal != null) {
    left(padLR("Subtotal", fmtCur(t.subtotal), cw));
  }
  if (rs.show_discount_total !== false && Number(t.discount_amount ?? 0) > 0) {
    left(padLR(rs.show_savings ? "You saved" : "Discount", `-${fmtCur(t.discount_amount ?? 0)}`, cw));
  }
  if (rs.show_tax_breakdown !== false && Number(t.tax_amount ?? 0) > 0) {
    // Per-rate tax buckets (Wave 6b.2) — when items expose `tax_rate` +
    // `tax_amount`, roll them into buckets so the customer sees each
    // rate individually (e.g. "VAT 16%    120.00"). Fall back to the
    // aggregate "Tax" row when buckets can't be resolved.
    const buckets = new Map<string, { label: string; amount: number }>();
    for (const it of t.items ?? []) {
      const rate = Number(it.tax_rate ?? 0);
      const amt = Number(it.tax_amount ?? 0);
      if (!rate || !Number.isFinite(amt) || amt === 0) continue;
      const label = it.tax_rate_name?.trim()
        || `Tax ${Number.isInteger(rate) ? rate : rate.toFixed(2)}%`;
      const cur = buckets.get(label) ?? { label, amount: 0 };
      cur.amount += amt;
      buckets.set(label, cur);
    }
    if (buckets.size > 0) {
      for (const b of buckets.values()) {
        left(padLR(b.label, fmtCur(b.amount), cw));
      }
    } else {
      left(padLR("Tax", fmtCur(t.tax_amount ?? 0), cw));
    }
  }

  push(padLR("TOTAL", fmtCur(t.total_amount), cw), {
    align: "left",
    bold: true,
    large: rs.font_size === "large",
  });

  // ── Payments + change ───────────────────────────────────────────────
  if (rs.show_payment_method !== false && (t.payments?.length ?? 0) > 0) {
    rule();
    const labels: Record<string, string> = {
      cash: "Cash", credit_card: "Credit Card", debit_card: "Debit Card",
      mobile_money: "Mobile Money", mpesa: "M-Pesa", credit: "Credit (A/R)",
      bank_transfer: "Bank Transfer", gift_card: "Gift Card", other: "Other",
    };
    for (const p of t.payments) {
      const label = labels[p.payment_method] ?? p.payment_method;
      left(padLR(label, fmtCur(Number(p.amount ?? 0)), cw));
      if (p.reference) left("  Ref: " + p.reference);
    }
  }
  if (rs.show_amount_tendered && t.amount_tendered != null) {
    left(padLR("Tendered", fmtCur(t.amount_tendered), cw));
  }
  if (rs.show_change_due && t.change_due != null && t.change_due > 0) {
    left(padLR("Change", fmtCur(t.change_due), cw));
  }
  rule();

  // ── eTIMS QR ─────────────────────────────────────────────────────────
  let qrPayload: string | undefined;
  if (rs.show_etims_qr && t.etims_qr_data) {
    center("KRA eTIMS Verification", { bold: true });
    push("", { align: "center", qr: true });
    qrPayload = String(t.etims_qr_data);
    if (rs.show_etims_info && t.etims_cu_number) center(`CU: ${t.etims_cu_number}`);
    rule();
  }

  // ── Notes / Terms (non-POS docs) ────────────────────────────────────
  if (t.notes && String(t.notes).trim()) {
    blank();
    left("Notes:");
    for (const l of wordWrap(String(t.notes).trim(), cw - 2)) left("  " + l);
  }
  if (t.terms && String(t.terms).trim()) {
    blank();
    left("Terms:");
    for (const l of wordWrap(String(t.terms).trim(), cw - 2)) left("  " + l);
  }

  // ── Footer ──────────────────────────────────────────────────────────
  if (typeof rs.receipt_footer === "string" && rs.receipt_footer) {
    blank();
    for (const l of wordWrap(rs.receipt_footer, cw)) center(l);
  }
  if (rs.show_return_policy && rs.return_policy_text) {
    blank();
    for (const l of wordWrap(String(rs.return_policy_text), cw)) center(l);
  }

  return { lines, meta, columns: cols, marginCols, paper, font, qrPayload };
}