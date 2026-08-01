/**
 * Receipt-settings + printer-capability types shared by the ESC/POS wire
 * path and its callers.
 *
 * Extracted from the deleted legacy `builder.ts` (`buildDocumentEscPos`),
 * which was a second, divergent row producer for thermal receipts. The
 * canonical producer is `_shared/receipt/lines.ts` (Line[] AST) encoded by
 * `renderLinesEscPos` / `renderDocumentEscPos` (ADR-0085).
 */

export type EscPosWidth = "40mm" | "58mm" | "80mm";

// Subset of ExtendedReceiptSettings the builder actually reads. Kept as
// a loose Partial<...> so a stale settings row can't break rendering.
export interface ReceiptSettingsInput {
  // Paper / typography
  paper_size?: "40mm" | "58mm" | "80mm" | "A4" | "A5" | "Letter";
  font_size?: "small" | "medium" | "large";
  line_spacing?: "compact" | "normal" | "relaxed";

  // Header
  receipt_header?: string;
  show_store_name?: boolean;
  show_store_address?: boolean;
  show_store_phone?: boolean;
  show_store_email?: boolean;

  // Meta
  show_receipt_number?: boolean;
  show_date_time?: boolean;
  show_cashier_name?: boolean;
  cashier_label_format?: "cashier" | "served_by";
  show_register_id?: boolean;
  show_customer_name?: boolean;

  // Items
  show_item_sku?: boolean;
  show_item_quantity?: boolean;
  show_unit_price?: boolean;
  show_item_discount?: boolean;
  truncate_long_names?: boolean;
  max_item_name_length?: number;
  item_display_format?: "single-line" | "two-lines" | "tabular";
  /**
   * Multi-unit: print a "(20 ea)" sub-row under any item sold with
   * packaging (e.g. "2 Strip") so the base-unit equivalent is visible.
   * Default ON — mirrors the in-app receipt preview.
   */
  show_base_unit_breakdown?: boolean;

  // Totals
  show_subtotal?: boolean;
  show_discount_total?: boolean;
  show_tax_breakdown?: boolean;
  show_tax_rate?: boolean;
  show_savings?: boolean;

  // Payment
  show_payment_method?: boolean;
  show_amount_tendered?: boolean;
  show_change_due?: boolean;

  // Footer / compliance
  receipt_footer?: string;
  show_return_policy?: boolean;
  return_policy_text?: string;
  show_barcode?: boolean;
  show_qr_code?: boolean;
  show_etims_info?: boolean;
  show_etims_qr?: boolean;

  // ── Stage X8 — configurability extensions (all optional) ──
  header_align?: "left" | "center" | "right";
  meta_align?: "left" | "center" | "right";
  items_header_align?: "left" | "center" | "right";
  totals_align?: "left" | "center" | "right";
  footer_align?: "left" | "center" | "right";

  currency_display?: "symbol" | "code" | "none";
  currency_position?: "before" | "after";
  currency_symbol_override?: string;
  decimal_places?: number;
  thousands_separator?: "," | "." | " " | "";

  date_format?: "iso" | "dmy" | "mdy" | "long";
  time_format?: "12h" | "24h" | "none";

  // ── Stage R2 — line-item enrichment + print behavior (all optional) ──
  show_item_modifiers?: boolean;
  show_refund_banner?: boolean;
  copies?: number;                // 1..3
  copy_labels?: string[];
  cut_mode?: "full" | "partial" | "none";
  feed_lines_after?: number;      // 0..10

  // ── Phase A (receipt overhaul) — margins ──
  /** Left/right margin in character columns. Defaults: 1 on 58mm, 2 on 80mm. */
  margin_cols?: number;

  // ── Phase B — section template + title rules ──
  /**
   * Tenant-defined ordering for non-pinned blocks. Validated by
   * `resolveBlockOrder` (see `blocks.ts`). When undefined, the receipt
   * renders in DEFAULT_BLOCK_ORDER (byte-identical to historical output).
   */
  section_order?: string[];
  /**
   * When true the title resolver suppresses the "TAX INVOICE" promotion
   * for fiscalized cash sales — they print "SALES RECEIPT" instead.
   * On-account sales still title "INVOICE".
   */
  legacy_title_mode?: boolean;
}

export interface PrinterCapabilities {
  auto_cut?: boolean;
  partial_cut?: boolean;
  qr_native?: boolean;
  code128_native?: boolean;
  /** Optional override of the column count. */
  columns_override?: number;
}
