/**
 * Document Template Types
 * Business-level document customization settings.
 * Cosmetic styling (colors, fonts, logos) is hardcoded in the server-side renderer.
 */

// Template types supported. These mirror the lending document kinds the
// document engine registers in `resolveSourceDocumentRecord.ts`.
export type DocumentTemplateType =
  | 'loan_agreement'
  | 'repayment_schedule'
  | 'loan_statement'
  | 'client_statement'
  | 'loan_payment_receipt';

// Totals position options
export type TotalsPosition = 'right' | 'center' | 'full-width';

/**
 * Document Template Settings Interface
 * Only business-relevant controls — no cosmetic styling.
 */
export interface DocumentTemplate {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  template_type: DocumentTemplateType;
  template_name: string;
  is_default: boolean;
  is_active: boolean;
  
  // Header settings
  show_company_name: boolean;
  show_company_address: boolean;
  show_company_phone: boolean;
  show_company_email: boolean;
  show_tax_id: boolean;
  header_text: string | null;
  document_title_format: string;
  
  // Content/Items table settings
  show_line_numbers: boolean;
  show_item_sku: boolean;
  show_item_description: boolean;
  show_unit_price: boolean;
  show_quantity: boolean;
  show_tax_column: boolean;
  show_discount_column: boolean;
  show_subtotals_per_item: boolean;
  columns_layout: Record<string, number>;
  
  // Totals settings
  show_subtotal: boolean;
  show_discount_total: boolean;
  show_tax_breakdown: boolean;
  show_total_in_words: boolean;
  totals_position: TotalsPosition;
  
  // Footer settings
  show_payment_instructions: boolean;
  payment_instructions: string | null;
  bank_details: BankDetails;
  show_bank_details: boolean;
  footer_text: string | null;
  show_signature_line: boolean;
  signature_label: string;
  show_terms: boolean;
  terms_text: string | null;
  
  // Status badge
  show_status_badge: boolean;
  
  // Advanced settings
  watermark_text: string | null;
  watermark_opacity: number;
  
  // Timestamps
  created_by: string | null;
  created_at: string;
  updated_at: string;

  // Legacy fields kept for DB compatibility (not exposed in UI)
  logo_position: string;
  logo_size: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  font_family: string;
  font_size_base: number;
  background_color: string;
  custom_css: string | null;
}

export interface BankDetails {
  bank_name?: string;
  account_name?: string;
  account_number?: string;
  branch?: string;
  swift_code?: string;
  iban?: string;
}

/**
 * Input type for creating/updating templates
 */
export interface DocumentTemplateInput {
  template_type: DocumentTemplateType;
  template_name: string;
  business_id?: string | null;
  branch_id?: string | null;
  is_default?: boolean;
  is_active?: boolean;
  
  // Header settings
  show_company_name?: boolean;
  show_company_address?: boolean;
  show_company_phone?: boolean;
  show_company_email?: boolean;
  show_tax_id?: boolean;
  header_text?: string | null;
  document_title_format?: string;
  
  // Content settings
  show_line_numbers?: boolean;
  show_item_sku?: boolean;
  show_item_description?: boolean;
  show_unit_price?: boolean;
  show_quantity?: boolean;
  show_tax_column?: boolean;
  show_discount_column?: boolean;
  show_subtotals_per_item?: boolean;
  columns_layout?: Record<string, number>;
  
  // Totals settings
  show_subtotal?: boolean;
  show_discount_total?: boolean;
  show_tax_breakdown?: boolean;
  show_total_in_words?: boolean;
  totals_position?: TotalsPosition;
  
  // Footer settings
  show_payment_instructions?: boolean;
  payment_instructions?: string | null;
  bank_details?: BankDetails;
  show_bank_details?: boolean;
  footer_text?: string | null;
  show_signature_line?: boolean;
  signature_label?: string;
  show_terms?: boolean;
  terms_text?: string | null;
  
  // Status badge
  show_status_badge?: boolean;
  
  // Payment methods (override only — org flag controls visibility)
  payment_method_ids?: string[];
  
  // Advanced
  watermark_text?: string | null;
  watermark_opacity?: number;
}

/**
 * Default template values
 */
export const DEFAULT_TEMPLATE: DocumentTemplateInput = {
  template_type: 'loan_payment_receipt',
  template_name: 'Default Template',
  is_default: true,
  is_active: true,
  
  // Header
  show_company_name: true,
  show_company_address: true,
  show_company_phone: true,
  show_company_email: true,
  show_tax_id: false,
  header_text: null,
  document_title_format: 'REPAYMENT RECEIPT',
  
  // Content
  show_line_numbers: true,
  show_item_sku: false,
  show_item_description: true,
  show_unit_price: true,
  show_quantity: true,
  show_tax_column: true,
  show_discount_column: false,
  show_subtotals_per_item: false,
  columns_layout: { description: 40, quantity: 10, unit_price: 15, tax: 10, amount: 15 },
  
  // Totals
  show_subtotal: true,
  show_discount_total: true,
  show_tax_breakdown: true,
  show_total_in_words: false,
  totals_position: 'right',
  
  // Footer
  show_payment_instructions: true,
  payment_instructions: null,
  bank_details: {},
  show_bank_details: true,
  footer_text: null,
  show_signature_line: false,
  signature_label: 'Authorized Signature',
  show_terms: true,
  terms_text: null,
  
  // Status badge
  show_status_badge: false,
  
  // Advanced
  watermark_text: null,
  watermark_opacity: 0.1,
};

/**
 * Document type labels
 */
export const DOCUMENT_TYPE_LABELS: Record<DocumentTemplateType, string> = {
  loan_agreement: 'Loan Agreement',
  repayment_schedule: 'Repayment Schedule',
  loan_statement: 'Loan Statement',
  client_statement: 'Client Statement',
  loan_payment_receipt: 'Repayment Receipt',
};
