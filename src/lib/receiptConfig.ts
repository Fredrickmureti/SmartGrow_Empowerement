/**
 * Receipt Configuration
 * Paper sizes, template presets, and utility functions
 */

import type {
  PaperSize,
  PaperConfig,
  FontSize,
  LineSpacing,
  ReceiptTemplate,
  ExtendedReceiptSettings,
  ItemDisplayFormat,
} from "@/types/receipt";

/**
 * Paper configurations for different receipt sizes
 */
export const PAPER_CONFIGS: Record<PaperSize, PaperConfig> = {
  "40mm": {
    width: "40mm",
    columns: 24,
    fontSize: { small: 8, medium: 9, large: 10 },
    lineHeight: { compact: 1.1, normal: 1.3, relaxed: 1.5 },
    padding: "2mm",
    isThermal: true,
  },
  "58mm": {
    width: "58mm",
    columns: 32,
    fontSize: { small: 9, medium: 10, large: 11 },
    lineHeight: { compact: 1.1, normal: 1.3, relaxed: 1.5 },
    padding: "3mm",
    isThermal: true,
  },
  "80mm": {
    // Receipt overhaul Phase A.2 — 80mm at ESC/POS Font A is 48 columns,
    // not 42. The 42 figure was Font B / preview-only and caused the
    // settings preview to disagree with the actual print (Qty column drift).
    width: "80mm",
    columns: 48,
    fontSize: { small: 10, medium: 12, large: 14 },
    lineHeight: { compact: 1.2, normal: 1.4, relaxed: 1.6 },
    padding: "5mm",
    isThermal: true,
  },
  A4: {
    width: "210mm",
    columns: 80,
    fontSize: { small: 10, medium: 12, large: 14 },
    lineHeight: { compact: 1.3, normal: 1.5, relaxed: 1.8 },
    padding: "15mm",
    isThermal: false,
  },
  Letter: {
    width: "216mm",
    columns: 80,
    fontSize: { small: 10, medium: 12, large: 14 },
    lineHeight: { compact: 1.3, normal: 1.5, relaxed: 1.8 },
    padding: "15mm",
    isThermal: false,
  },
  A5: {
    width: "148mm",
    columns: 60,
    fontSize: { small: 10, medium: 12, large: 14 },
    lineHeight: { compact: 1.3, normal: 1.5, relaxed: 1.8 },
    padding: "10mm",
    isThermal: false,
  },
};

/**
 * Template presets - predefined configurations for common use cases
 */
export const TEMPLATE_PRESETS: Record<ReceiptTemplate, Partial<ExtendedReceiptSettings>> = {
  minimal: {
    show_logo: true,
    logo_size: "small",
    show_store_name: true,
    show_store_address: false,
    show_store_phone: false,
    show_store_email: false,
    show_receipt_number: true,
    show_date_time: true,
    show_cashier_name: false,
    show_register_id: false,
    show_customer_name: false,
    show_item_sku: false,
    show_item_quantity: true,
    show_unit_price: false,
    show_item_discount: false,
    truncate_long_names: true,
    max_item_name_length: 20,
    item_display_format: "single-line",
    show_subtotal: false,
    show_discount_total: true,
    show_tax_breakdown: false,
    show_tax_rate: false,
    show_savings: false,
    show_payment_method: true,
    show_amount_tendered: false,
    show_change_due: false,
    show_return_policy: false,
    show_barcode: false,
    show_qr_code: false,
    show_etims_info: false,
    show_etims_qr: false,
    line_spacing: "compact",
    font_size: "small",
  },
  standard: {
    show_logo: true,
    logo_size: "medium",
    show_store_name: true,
    show_store_address: true,
    show_store_phone: true,
    show_store_email: false,
    show_receipt_number: true,
    show_date_time: true,
    show_cashier_name: true,
    show_register_id: false,
    show_customer_name: true,
    show_item_sku: false,
    show_item_quantity: true,
    show_unit_price: true,
    show_item_discount: true,
    truncate_long_names: true,
    max_item_name_length: 28,
    item_display_format: "single-line",
    show_subtotal: true,
    show_discount_total: true,
    show_tax_breakdown: true,
    show_tax_rate: false,
    show_savings: true,
    show_payment_method: true,
    show_amount_tendered: true,
    show_change_due: true,
    show_return_policy: false,
    show_barcode: false,
    show_qr_code: false,
    show_etims_info: true,
    show_etims_qr: true,
    line_spacing: "normal",
    font_size: "medium",
  },
  detailed: {
    show_logo: true,
    logo_size: "large",
    show_store_name: true,
    show_store_address: true,
    show_store_phone: true,
    show_store_email: true,
    show_receipt_number: true,
    show_date_time: true,
    show_cashier_name: true,
    show_register_id: true,
    show_customer_name: true,
    show_item_sku: true,
    show_item_quantity: true,
    show_unit_price: true,
    show_item_discount: true,
    truncate_long_names: false,
    max_item_name_length: 40,
    item_display_format: "two-lines",
    show_subtotal: true,
    show_discount_total: true,
    show_tax_breakdown: true,
    show_tax_rate: true,
    show_savings: true,
    show_payment_method: true,
    show_amount_tendered: true,
    show_change_due: true,
    show_return_policy: true,
    show_barcode: true,
    show_qr_code: true,
    show_etims_info: true,
    show_etims_qr: true,
    line_spacing: "relaxed",
    font_size: "medium",
  },
  custom: {
    // Custom uses whatever the user has configured
  },
};

/**
 * Default extended receipt settings
 */
export const DEFAULT_EXTENDED_RECEIPT_SETTINGS: ExtendedReceiptSettings = {
  // Paper & Layout
  paper_size: "80mm",
  template: "standard",
  font_size: "medium",
  line_spacing: "normal",
  
  // Branding
  show_logo: true,
  logo_size: "medium",
  primary_color: "#10b981",
  
  // Header Section
  receipt_header: "",
  show_store_name: true,
  show_store_address: true,
  show_store_phone: true,
  show_store_email: false,
  
  // Transaction Details
  show_receipt_number: true,
  show_date_time: true,
  show_cashier_name: true,
  cashier_label_format: "cashier",
  show_register_id: false,
  show_customer_name: true,
  
  // Items Section
  show_item_sku: false,
  show_item_quantity: true,
  show_unit_price: true,
  show_item_discount: true,
  truncate_long_names: true,
  max_item_name_length: 28,
  item_display_format: "single-line",
  
  // Totals Section
  show_subtotal: true,
  show_discount_total: true,
  show_tax_breakdown: true,
  show_tax_rate: false,
  show_savings: true,
  
  // Payment Section
  show_payment_method: true,
  show_amount_tendered: true,
  show_change_due: true,
  
  // Footer Section
  receipt_footer: "Thank you for your purchase!",
  show_return_policy: false,
  return_policy_text: "",
  show_barcode: false,
  show_qr_code: false,
  
  // Compliance (eTIMS)
  show_etims_info: true,
  show_etims_qr: true,
  
  // POS-specific
  auto_print_receipt: true,

  // Stage X8 — configurability extensions (defaults reproduce previous behaviour)
  header_align: 'center',
  meta_align: 'center',
  items_header_align: 'left',
  totals_align: 'left',
  footer_align: 'center',

  currency_display: 'code',
  currency_position: 'before',
  currency_symbol_override: '',
  decimal_places: 2,
  thousands_separator: ',',

  date_format: 'iso',
  time_format: '24h',

  // Stage R2 — line-item enrichment + print behavior (defaults reproduce previous behaviour)
  show_item_modifiers: true,
  show_refund_banner: true,
  copies: 1,
  copy_labels: [],
  cut_mode: 'full',
  feed_lines_after: 4,
};

/**
 * Paper size display labels
 */
export const PAPER_SIZE_LABELS: Record<PaperSize, string> = {
  "40mm": "40mm Thermal (Compact / Label)",
  "58mm": "58mm Thermal (Small)",
  "80mm": "80mm Thermal (Standard)",
  A4: "A4 (Full Page)",
  Letter: "Letter (US)",
  A5: "A5 (Half Page)",
};

/**
 * Template display labels
 */
export const TEMPLATE_LABELS: Record<ReceiptTemplate, string> = {
  minimal: "Minimal",
  standard: "Standard",
  detailed: "Detailed",
  custom: "Custom",
};

/**
 * Font size display labels
 */
export const FONT_SIZE_LABELS: Record<FontSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/**
 * Line spacing display labels
 */
export const LINE_SPACING_LABELS: Record<LineSpacing, string> = {
  compact: "Compact",
  normal: "Normal",
  relaxed: "Relaxed",
};

/**
 * Item display format — single source of truth (Stage R3a).
 *
 * Both the settings editor UI and the ESC/POS builder branch on the same
 * enum values. This array is the canonical list; `ITEM_DISPLAY_FORMAT_LABELS`
 * is derived from it for backwards compatibility.
 */
export interface ItemDisplayFormatOption {
  value: ItemDisplayFormat;
  label: string;
  description: string;
}

export const ITEM_DISPLAY_FORMAT_OPTIONS: ItemDisplayFormatOption[] = [
  {
    value: "single-line",
    label: "Compact",
    description: "One line per item — qty, name, total. Best for narrow paper.",
  },
  {
    value: "two-lines",
    label: "Detailed",
    description: "Name on the first line, qty/price/total below. No truncation.",
  },
  {
    value: "tabular",
    label: "Tabular",
    description: "4-column grid with optional SKU. Best on 80mm paper.",
  },
];

export const ITEM_DISPLAY_FORMAT_LABELS: Record<ItemDisplayFormat, string> =
  ITEM_DISPLAY_FORMAT_OPTIONS.reduce(
    (acc, o) => ({ ...acc, [o.value]: o.label }),
    {} as Record<ItemDisplayFormat, string>,
  );

/**
 * Get paper configuration for a given paper size
 */
export function getPaperConfig(paperSize: PaperSize): PaperConfig {
  return PAPER_CONFIGS[paperSize] || PAPER_CONFIGS["80mm"];
}

/**
 * Apply template preset to current settings
 */
export function applyTemplatePreset(
  currentSettings: ExtendedReceiptSettings,
  template: ReceiptTemplate
): ExtendedReceiptSettings {
  const preset = TEMPLATE_PRESETS[template];
  return {
    ...currentSettings,
    ...preset,
    template,
  };
}

/**
 * Truncate text to fit within column limit
 */
export function truncateToColumns(text: string, maxColumns: number): string {
  if (text.length <= maxColumns) return text;
  return text.slice(0, maxColumns - 3) + "...";
}

/**
 * Format item line for thermal receipt (with quantity and price alignment)
 */
export function formatReceiptLine(
  name: string,
  amount: string,
  totalColumns: number
): string {
  const minSpacing = 2;
  const availableForName = totalColumns - amount.length - minSpacing;
  const truncatedName = truncateToColumns(name, availableForName);
  const spacing = totalColumns - truncatedName.length - amount.length;
  return truncatedName + " ".repeat(Math.max(spacing, minSpacing)) + amount;
}

/**
 * Check if a paper size is thermal (for ESC/POS printing considerations)
 */
export function isThermalPaper(paperSize: PaperSize): boolean {
  return PAPER_CONFIGS[paperSize]?.isThermal ?? false;
}

/**
 * Format amount for receipt display WITHOUT currency code
 * This prevents overlapping text on narrow thermal receipts
 * Currency symbol should only appear on grand total (if at all)
 */
export function formatReceiptAmount(amount: number, decimalPlaces: number = 2): string {
  return amount.toFixed(decimalPlaces).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
