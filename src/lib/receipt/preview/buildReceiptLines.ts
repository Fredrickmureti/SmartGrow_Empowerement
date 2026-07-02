/**
 * buildReceiptLines — Phase A.3 client-side mirror of the ESC/POS engine.
 *
 * Returns the exact monospace text rows the printer would emit for a sample
 * (or real) receipt, given a merged `ExtendedReceiptSettings`. The on-screen
 * MonospacePreview component renders these rows verbatim so the customer-
 * facing preview matches the printer byte-for-byte at the column level.
 *
 * It intentionally REUSES the same engine pieces that `builder.ts` uses
 * (PrinterProfile + LAYOUT_REGISTRY + solveColumns / renderHeader / renderRow
 * + padLR + wordWrap) so a regression in either side is impossible without
 * also breaking the shared engine tests.
 *
 * NOT covered (preview-only stand-ins): ESC/POS GS-k QR, native barcodes,
 * CP858 charset translation. These render as text placeholders since their
 * physical bytes don't translate to characters.
 */

import {
  resolvePrinterProfile,
  contentWidth,
  type PaperWidth,
  type Font,
} from "@/lib/receipt/engine/PrinterProfile";
import {
  solveColumns,
  renderHeader,
  renderRow,
  padLR,
  wordWrap,
} from "@/lib/receipt/engine/ColumnLayout";
import {
  LAYOUT_REGISTRY,
  resolveLegacyLayout,
  pickFittingLayout,
} from "@/lib/receipt/layouts";
import { assembleItems } from "@/lib/receipt/items";
import type {
  ExtendedReceiptSettings,
  ReceiptCompanyData,
  ReceiptTransactionData,
} from "@/types/receipt";

export type LineAlign = "left" | "center" | "right";

export interface LineMeta {
  align: LineAlign;
  bold?: boolean;
  large?: boolean;
  /** Pure horizontal rule (the `-` line). Helps the renderer style it subtly. */
  rule?: boolean;
  /** Render an inline QR placeholder block instead of a text line. */
  qr?: boolean;
}

export interface BuildReceiptLinesResult {
  /**
   * Rows already padded to `profile.columns` (left margin applied for
   * left-aligned rows; centred / right rows are NOT pre-padded — the renderer
   * positions them inside the full column width).
   */
  lines: string[];
  meta: LineMeta[];
  columns: number;
  marginCols: number;
  paper: PaperWidth;
  font: Font;
}

export interface BuildReceiptLinesInput {
  settings: ExtendedReceiptSettings;
  company: ReceiptCompanyData;
  transaction: ReceiptTransactionData;
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

function fmtDateTime(
  iso: string,
  dateFormat: ExtendedReceiptSettings["date_format"] = "iso",
  timeFormat: ExtendedReceiptSettings["time_format"] = "24h",
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  const h24 = d.getHours();
  const mi = d.getMinutes();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo - 1];
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

export function buildReceiptLines(input: BuildReceiptLinesInput): BuildReceiptLinesResult {
  const { settings: rs, company, transaction: t } = input;

  // Mirror builder.ts paperWidth + font selection.
  const paper: PaperWidth =
    rs.paper_size === "40mm" ? "40mm" :
    rs.paper_size === "58mm" ? "58mm" : "80mm";
  const font: Font = rs.font_size === "small" ? "B" : "A";
  const profile = resolvePrinterProfile({
    paper,
    font,
    marginCols: (rs as unknown as { margin_cols?: number }).margin_cols,
  });
  const cols = profile.columns;
  const marginCols = profile.marginCols;
  const cw = contentWidth(profile);
  const marginPad = " ".repeat(marginCols);

  const lines: string[] = [];
  const meta: LineMeta[] = [];

  const push = (text: string, m: LineMeta) => {
    if (m.align === "left") {
      // Mirror builder.ts Phase A.6 — clamp content to cw first, THEN add margin.
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
  const right = (s: string) => push(s, { align: "right" });
  const blank = () => push("", { align: "left" });
  const rule = (ch = "-") => push(ch.repeat(cw), { align: "left", rule: true });

  // Currency helpers (mirror builder.ts fmtCur but symbol-only for preview).
  const decimals = rs.decimal_places ?? 2;
  const thousands = (rs.thousands_separator ?? ",") as string;
  const fmtCur = (n: number) => {
    const num = fmtNumber(Number(n ?? 0), decimals, thousands);
    const sym = rs.currency_symbol_override?.trim();
    if (rs.currency_display === "none") return num;
    if (rs.currency_display === "symbol" && sym) {
      return rs.currency_position === "after" ? `${num} ${sym}` : `${sym}${num}`;
    }
    return num; // 'code' rendering needs runtime currency lookup; preview keeps it numeric.
  };
  const fmtMoney = (n: number) => fmtNumber(Number(n ?? 0), decimals, thousands);

  // ── Header ─────────────────────────────────────────────────────────────
  if (rs.show_logo && company.logo_url) {
    center("[ logo ]");
  }
  if (rs.show_store_name) {
    center(truncate(company.name ?? "", cw), { bold: true, large: rs.font_size === "large" });
  }
  if (rs.show_store_address && company.address) {
    for (const l of wordWrap(company.address, cw)) center(l);
    if (company.city) center(truncate(company.city, cw));
  }
  if (rs.show_store_phone && company.phone) center(truncate(company.phone, cw));
  if (rs.show_store_email && company.email) center(truncate(company.email, cw));
  if (rs.receipt_header) {
    for (const l of wordWrap(rs.receipt_header, cw)) center(l);
  }
  rule();

  // ── Title + meta ───────────────────────────────────────────────────────
  center("RECEIPT", { bold: true });
  if (rs.show_receipt_number && t.transaction_number) {
    left(padLR("No:", t.transaction_number, cw));
  }
  if (rs.show_date_time && t.created_at) {
    left(padLR("Date:", fmtDateTime(t.created_at, rs.date_format, rs.time_format), cw));
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
  rule();

  // ── Items (engine-driven, byte-identical to builder.ts via assembleItems) ──
  const preferredLayoutId = resolveLegacyLayout(rs.item_display_format, !!rs.show_item_sku);
  const ctx = {
    showSku: !!rs.show_item_sku,
    showQty: !!rs.show_item_quantity,
    showUnitPrice: !!rs.show_unit_price,
    showDiscount: !!rs.show_item_discount,
    showTaxBreakdown: !!rs.show_tax_breakdown,
    showTaxRate: !!rs.show_tax_rate,
    showModifiers: !!rs.show_item_modifiers,
    truncateLongNames: !!rs.truncate_long_names,
    maxNameLen: rs.max_item_name_length ?? 28,
  };
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
    // padding for left-align is already added by `push`; row.text comes
    // already padded to `cw` via padLR/renderRow, so monospace alignment is
    // preserved.
  }
  rule();

  // ── Totals ─────────────────────────────────────────────────────────────
  if (rs.show_subtotal && t.subtotal != null) left(padLR("Subtotal", fmtCur(t.subtotal), cw));
  if (rs.show_discount_total && Number(t.discount_amount ?? 0) > 0) {
    left(padLR(rs.show_savings ? "You saved" : "Discount", `-${fmtCur(t.discount_amount)}`, cw));
  }
  if (rs.show_tax_breakdown && Number(t.tax_amount ?? 0) > 0) {
    left(padLR("Tax", fmtCur(t.tax_amount), cw));
  }
  push(padLR("TOTAL", fmtCur(t.total_amount), cw), { align: "left", bold: true, large: rs.font_size === "large" });

  // ── Payments + change ─────────────────────────────────────────────────
  if (rs.show_payment_method && (t.payments?.length ?? 0) > 0) {
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

  // ── eTIMS QR placeholder ───────────────────────────────────────────────
  if (rs.show_etims_qr && t.etims_qr_data) {
    center("KRA eTIMS Verification", { bold: true });
    push("", { align: "center", qr: true });
    if (rs.show_etims_info && t.etims_cu_number) {
      center(`CU: ${t.etims_cu_number}`);
    }
    rule();
  }

  // ── Footer ────────────────────────────────────────────────────────────
  if (rs.receipt_footer) {
    for (const l of wordWrap(rs.receipt_footer, cw)) center(l);
  }
  if (rs.show_return_policy && rs.return_policy_text) {
    blank();
    for (const l of wordWrap(rs.return_policy_text, cw)) center(l);
  }

  return { lines, meta, columns: cols, marginCols, paper, font };
}

/** Sample transaction used by the Settings preview when no live data exists. */
export const SAMPLE_TRANSACTION: ReceiptTransactionData = {
  id: "preview-001",
  transaction_number: "TXN-2026-0001",
  created_at: new Date().toISOString(),
  subtotal: 2500,
  tax_amount: 400,
  discount_amount: 200,
  total_amount: 2700,
  amount_tendered: 3000,
  change_due: 300,
  customer_name: "John Doe",
  cashier_name: "Jane Smith",
  register_id: "REG-01",
  items: [
    { product_name: "Premium Coffee Blend 250g", sku: "COF-001", quantity: 2, unit_price: 850, discount_amount: 100, line_total: 1600 },
    { product_name: "Organic Green Tea", sku: "TEA-042", quantity: 1, unit_price: 650, discount_amount: 0, line_total: 650 },
    { product_name: "Chocolate Croissant", sku: "BAK-015", quantity: 3, unit_price: 150, discount_amount: 100, line_total: 350 },
  ],
  payments: [{ payment_method: "cash", amount: 3000 }],
  etims_cu_number: "CU-123456789",
  etims_qr_data: "https://etims.kra.go.ke/verify/123456",
};
