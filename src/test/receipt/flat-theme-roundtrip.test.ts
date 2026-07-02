/**
 * Phase B.3 — flatToTheme / themeToFlat roundtrip goldens.
 *
 * For every flat settings input we care about, `themeToFlat(flatToTheme(f), f)`
 * must reproduce `f` on the rendering-relevant subset of fields.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_EXTENDED_RECEIPT_SETTINGS } from "@/lib/receiptConfig";
import { flatToTheme, themeToFlat } from "@/lib/receipt/migrations/flatToTheme";
import type { ExtendedReceiptSettings } from "@/types/receipt";

const RENDER_KEYS: Array<keyof ExtendedReceiptSettings> = [
  "paper_size",
  "font_size",
  "line_spacing",
  "show_logo",
  "logo_size",
  "receipt_header",
  "show_store_name",
  "show_store_address",
  "show_store_phone",
  "show_store_email",
  "show_receipt_number",
  "show_date_time",
  "show_cashier_name",
  "cashier_label_format",
  "show_register_id",
  "show_customer_name",
  "show_item_sku",
  "show_item_quantity",
  "show_unit_price",
  "show_item_discount",
  "truncate_long_names",
  "max_item_name_length",
  "item_display_format",
  "show_subtotal",
  "show_discount_total",
  "show_tax_breakdown",
  "show_tax_rate",
  "show_savings",
  "show_payment_method",
  "show_amount_tendered",
  "show_change_due",
  "receipt_footer",
  "show_return_policy",
  "return_policy_text",
  "show_barcode",
  "show_qr_code",
  "show_etims_info",
  "show_etims_qr",
  "auto_print_receipt",
  "header_align",
  "meta_align",
  "totals_align",
  "footer_align",
  "currency_display",
  "currency_position",
  "currency_symbol_override",
  "decimal_places",
  "thousands_separator",
  "date_format",
  "time_format",
  "show_item_modifiers",
  "copies",
  "cut_mode",
  "feed_lines_after",
];

function pickRender(s: ExtendedReceiptSettings): Partial<ExtendedReceiptSettings> {
  const out: Record<string, unknown> = {};
  for (const k of RENDER_KEYS) out[k as string] = s[k];
  return out as Partial<ExtendedReceiptSettings>;
}

function variants(): ExtendedReceiptSettings[] {
  const base = DEFAULT_EXTENDED_RECEIPT_SETTINGS;
  return [
    base,
    { ...base, paper_size: "58mm", font_size: "small", line_spacing: "compact" },
    { ...base, paper_size: "80mm", font_size: "large", line_spacing: "relaxed", item_display_format: "tabular", show_item_sku: true },
    { ...base, item_display_format: "two-lines", show_item_sku: true },
    { ...base, currency_display: "symbol", currency_position: "after", currency_symbol_override: "KSh", decimal_places: 0, thousands_separator: " " },
    { ...base, date_format: "long", time_format: "12h", cashier_label_format: "served_by" },
    { ...base, show_return_policy: true, return_policy_text: "All sales final.", copies: 2, cut_mode: "partial", feed_lines_after: 6 },
    { ...base, show_etims_info: false, show_etims_qr: false, show_logo: false, auto_print_receipt: false },
  ];
}

describe("flatToTheme ↔ themeToFlat roundtrip", () => {
  for (const [i, v] of variants().entries()) {
    it(`roundtrip variant ${i} preserves rendering fields`, () => {
      const back = themeToFlat(flatToTheme(v), v);
      expect(pickRender(back)).toEqual(pickRender(v));
    });
  }
});
