/**
 * Receipt Customization Types
 * Supports multiple paper sizes and customizable templates like QuickBooks POS
 */

// Paper sizes supported for receipts
export type PaperSize = '40mm' | '58mm' | '80mm' | 'A4' | 'Letter' | 'A5';

// Template presets
export type ReceiptTemplate = 'minimal' | 'standard' | 'detailed' | 'custom';

// Font size options
export type FontSize = 'small' | 'medium' | 'large';

// Line spacing options
export type LineSpacing = 'compact' | 'normal' | 'relaxed';

// Logo size options
export type LogoSize = 'small' | 'medium' | 'large';

// Item display format options
export type ItemDisplayFormat = 'single-line' | 'two-lines' | 'tabular';

// Cashier label format options
export type CashierLabelFormat = 'cashier' | 'served_by';

// Per-section text alignment (Stage X8)
export type SectionAlign = 'left' | 'center' | 'right';

// Currency rendering options (Stage X8)
export type CurrencyDisplay = 'symbol' | 'code' | 'none';
export type CurrencyPosition = 'before' | 'after';
export type ThousandsSeparator = ',' | '.' | ' ' | '';

// Date / time formatting (Stage X8)
//   'iso'      → 2026-05-12
//   'dmy'      → 12/05/2026
//   'mdy'      → 05/12/2026
//   'long'     → 12 May 2026
export type DateFormat = 'iso' | 'dmy' | 'mdy' | 'long';
export type TimeFormat = '12h' | '24h' | 'none';

// Stage R2 — print behavior
//   'full'    → full cut after final feed (default, current behaviour)
//   'partial' → partial cut (GS V 1) — leaves a paper bridge
//   'none'    → no cut command (manual tear-off / continuous receipts)
export type CutMode = 'full' | 'partial' | 'none';

/**
 * Extended Receipt Settings Interface
 * Comprehensive configuration for receipt customization
 */
export interface ExtendedReceiptSettings {
  // Paper & Layout
  paper_size: PaperSize;
  template: ReceiptTemplate;
  font_size: FontSize;
  line_spacing: LineSpacing;
  
  // Branding
  show_logo: boolean;
  logo_size: LogoSize;
  primary_color: string;
  
  // Header Section
  receipt_header: string;
  show_store_name: boolean;
  show_store_address: boolean;
  show_store_phone: boolean;
  show_store_email: boolean;
  
  // Transaction Details
  show_receipt_number: boolean;
  show_date_time: boolean;
  show_cashier_name: boolean;
  cashier_label_format: CashierLabelFormat;
  show_register_id: boolean;
  show_customer_name: boolean;
  
  // Items Section
  show_item_sku: boolean;
  show_item_quantity: boolean;
  show_unit_price: boolean;
  show_item_discount: boolean;
  truncate_long_names: boolean;
  max_item_name_length: number;
  item_display_format: ItemDisplayFormat;
  
  // Totals Section
  show_subtotal: boolean;
  show_discount_total: boolean;
  show_tax_breakdown: boolean;
  show_tax_rate: boolean;
  show_savings: boolean;
  
  // Payment Section
  show_payment_method: boolean;
  show_amount_tendered: boolean;
  show_change_due: boolean;
  
  // Footer Section
  receipt_footer: string;
  show_return_policy: boolean;
  return_policy_text: string;
  show_barcode: boolean;
  show_qr_code: boolean;
  
  // Compliance (eTIMS)
  show_etims_info: boolean;
  show_etims_qr: boolean;

  // POS-specific (for auto printing)
  auto_print_receipt: boolean;

  // ── Stage X8 — configurability extensions (all optional with safe defaults) ──
  /** Per-section text alignment (default reproduces today's hardcoded layout). */
  header_align?: SectionAlign;        // org block — default 'center'
  meta_align?: SectionAlign;          // title + No/Date/Cashier — default 'center' for title, 'left' for rows
  items_header_align?: SectionAlign;  // tabular column-headers + line items — default 'left'
  totals_align?: SectionAlign;        // subtotal/tax/TOTAL block — default 'left' (with right-aligned amount column)
  footer_align?: SectionAlign;        // custom footer / thank-you — default 'center'

  /** Currency rendering. Defaults: code, before, 2dp, ',' separator. */
  currency_display?: CurrencyDisplay;
  currency_position?: CurrencyPosition;
  currency_symbol_override?: string;   // when set, used instead of currency code/symbol map
  decimal_places?: number;             // 0..4
  thousands_separator?: ThousandsSeparator;

  /** Date / time formatting. Default: 'iso' + '24h'. */
  date_format?: DateFormat;
  time_format?: TimeFormat;

  // ── Stage R2 — line-item enrichment + print behavior (all optional) ──
  /** Render `it.modifiers` and `it.notes` indented under each line. Default true. */
  show_item_modifiers?: boolean;
  /** Show "REFUND" banner above totals when document total is negative. Default true. */
  show_refund_banner?: boolean;
  /** Number of physical receipt copies to emit (1..3). Default 1. */
  copies?: number;
  /** Per-copy banner labels (e.g. ["MERCHANT COPY", "CUSTOMER COPY"]). When shorter than `copies`, extras get no banner. */
  copy_labels?: string[];
  /** Paper-cut behaviour at end of each copy. Default 'full'. */
  cut_mode?: CutMode;
  /** Lines to feed before cutting (0..10). Default 4. */
  feed_lines_after?: number;
}

/**
 * Paper configuration with sizing and column constraints
 */
export interface PaperConfig {
  width: string;
  columns: number;
  fontSize: Record<FontSize, number>;
  lineHeight: Record<LineSpacing, number>;
  padding: string;
  isThermal: boolean;
}

/**
 * Transaction data structure for receipt generation
 */
export interface ReceiptTransactionData {
  id: string;
  transaction_number: string;
  created_at: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total_amount: number;
  amount_tendered?: number;
  change_due?: number;
  customer_name?: string;
  cashier_name?: string;
  register_id?: string;
  items: ReceiptItemData[];
  payments: ReceiptPaymentData[];
  etims_cu_number?: string | null;
  etims_qr_data?: string | null;
}

export interface ReceiptItemData {
  product_name: string;
  sku?: string;
  quantity: number;
  unit_price: number;
  discount_amount?: number;
  line_total: number;
  // Tax metadata for per-item display and compliance
  tax_rate?: number;
  tax_amount?: number;
  tax_rate_name?: string;
  etims_tax_code?: string;
}

export interface ReceiptPaymentData {
  payment_method: string;
  amount: number;
  reference?: string;
}

/**
 * Company/Organization data for receipt header
 */
export interface ReceiptCompanyData {
  name: string;
  logo_url?: string | null;
  address?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  tax_id?: string | null;
}
