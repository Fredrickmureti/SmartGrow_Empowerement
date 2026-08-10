/**
 * Shared Document Data + Template Types
 *
 * After Stage G of the reporting consolidation, this module is *data-only*.
 * The 620-line HTML preview branch (renderDocument / renderStatementDocument)
 * has been removed — every caller renders PDFs through `_shared/pdfGenerator`
 * which composes the unified `_shared/pdf/*` primitives.
 *
 * Exports:
 *   - TemplateSettings, DEFAULT_TEMPLATE_SETTINGS
 *   - DocumentData, DocumentItem, DocumentType, Organization, Contact,
 *     CustomField, PaymentMethodData, StatementTransaction, StatementAgingBucket
 *   - fetchTemplate(), fetchCustomFields()
 *   - numberToWords()
 *
 * Currency / date formatting helpers are NOT re-exported from here. Import
 * them directly from `_shared/format/index.ts` — single source of truth.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface TemplateSettings {
  // Header settings
  show_company_name: boolean;
  show_company_address: boolean;
  show_company_phone: boolean;
  show_company_email: boolean;
  show_tax_id: boolean;
  header_text: string | null;
  document_title_format: string;

  // Content settings
  show_line_numbers: boolean;
  show_item_sku: boolean;
  show_item_description: boolean;
  show_unit_price: boolean;
  show_quantity: boolean;
  show_tax_column: boolean;
  show_discount_column: boolean;

  // Totals settings
  show_subtotal: boolean;
  show_discount_total: boolean;
  show_tax_breakdown: boolean;
  show_total_in_words: boolean;
  totals_position: string;

  // Footer settings
  show_payment_instructions: boolean;
  payment_instructions: string | null;
  bank_details: Record<string, string>;
  show_bank_details: boolean;
  footer_text: string | null;
  show_signature_line: boolean;
  signature_label: string;
  show_terms: boolean;
  terms_text: string | null;

  // Payment methods (structured)
  show_payment_methods: boolean;
  payment_method_ids: string[];

  // Advanced
  show_status_badge: boolean;
  watermark_text: string | null;
  watermark_opacity: number;

  // Legacy DB-backed fields. Kept on the type so `select("*")` from
  // document_templates still parses, but the PDF engine ignores them.
  // Slated for removal — see docs/reporting-stage-d.md.
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

export interface DocumentItem {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate?: number;
  tax_amount?: number;
  /** Human-readable tax label (e.g. "VAT") for per-rate breakdowns. */
  tax_rate_name?: string | null;
  discount_percent?: number;
  /** Absolute discount applied to the line, used by ESC/POS receipts. */
  discount_amount?: number;
  line_total: number;
  sku?: string | null;
  // Multi-unit pack provenance — see Phase B unification.
  /** Display-unit quantity (count of `packaging_label` units). */
  display_quantity?: number | null;
  /** Short pack label, e.g. "Box". Null when no pack chosen. */
  packaging_label?: string | null;
  /** Short base UoM code, e.g. "ea" / "tab". */
  base_uom_label?: string | null;
  /** Frozen unit snapshot, e.g. "Box × 10 ea". */
  uom_snapshot?: string | null;
}

export interface Organization {
  name: string;
  logo_url?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  tax_id?: string | null;
  /** IANA timezone, e.g. "Africa/Nairobi". Falls back to UTC when missing. */
  timezone?: string | null;
}

export interface Contact {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface CustomField {
  field_label: string;
  field_value: string | null;
  field_type: string;
  document_section: string;
}

export type DocumentType =
  | 'invoice' | 'estimate' | 'proforma' | 'credit_note' | 'purchase_order'
  | 'receipt' | 'delivery_note' | 'bill' | 'pos_receipt' | 'sales_order'
  | 'sales_return' | 'customer_statement'
  // Wave 10 (audit P3 #16): kitchen tickets are first-class. The render
  // pipeline routes them to a dedicated ESC/POS builder — they are NOT
  // receipts, do not carry totals/tax/fiscal blocks, and resolve to the
  // `kitchen_printer` role via the print policy resolver.
  | 'kitchen_ticket'
  // Phase 6.1 — HR letter renderers. Each letter is a prose document
  // with a signature block instead of a line-items table. They compose
  // the same shared PDF primitives (BrandedHeader / NotesBlock /
  // SignatureBlock / BrandedFooter) so branding, footers, and page
  // numbering stay identical to sales documents (ADR-0084).
  | 'offer_letter' | 'promotion_letter' | 'warning_letter' | 'contract_letter';

export interface PaymentMethodData {
  id: string;
  type: string; // 'bank' | 'mobile_money' | 'online' | 'cash' | 'crypto'
  label: string;
  // deno-lint-ignore no-explicit-any
  details: Record<string, any>;
  is_default: boolean;
  display_order: number;
  qr_code_enabled: boolean;
}

export interface StatementTransaction {
  date: string;
  type: string; // 'Invoice' | 'Payment' | 'Credit Note' | 'Refund' | …
  reference: string;
  description: string;
  charges: number;
  credits: number;
  balance: number;
  /** Drill-down anchors from the AR subledger. Not rendered. */
  source_id?: string;
  source_type?: string;
}


export interface StatementAgingBucket {
  label: string;
  amount: number;
}

export interface DocumentData {
  document_number: string;
  document_type: DocumentType;
  /** Override the rendered document title (e.g. "SALES ORDER" instead of "INVOICE") */
  document_type_label?: string;
  status: string;
  issue_date: string;
  due_date?: string;
  expiry_date?: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  amount_paid?: number;
  currency: string;
  notes?: string | null;
  terms?: string | null;
  /**
   * Structured commercial payment term (name + net days), frozen into the
   * snapshot. Distinct from `terms`, which is Terms & Conditions prose.
   */
  payment_term?: { id?: string; name?: string | null; days?: number | null } | null;
  contact?: Contact | null;
  organization?: Organization | null;
  branch_id?: string | null;
  /**
   * Legal-entity (Company) id this document belongs to. ALWAYS prefer this
   * over `organization_id` for branding, identity, and templates. The
   * tenant/workspace identity (organization) is intentionally never shown
   * on customer-facing PDFs — Odoo / Xero / QuickBooks pattern.
   */
  business_id?: string | null;
  /** Workspace/tenant id (rarely used; kept for fallback queries). */
  organization_id?: string | null;
  items: DocumentItem[];
  custom_fields?: CustomField[];
  payment_methods?: PaymentMethodData[];
  payment_method?: string;

  // Estimate-specific
  customer_signature_url?: string | null;
  signed_at?: string | null;
  signed_by_name?: string | null;

  // PO / Sales Order specific
  shipping_address?: string | null;
  /** Frozen printed bill-to / remit-to address; snapshot, not live data. */
  billing_address?: string | null;

  // Delivery note specific
  hide_amounts?: boolean;
  driver_name?: string | null;
  vehicle_number?: string | null;
  // Stage V2 — extended delivery logistics on the printed DN.
  // All optional; renderer hides any line whose value is null/empty.
  shipping_method?: string | null;
  carrier_name?: string | null;
  carrier_tracking_url?: string | null;
  tracking_number?: string | null;
  dispatch_route?: string | null;
  dispatch_officer_name?: string | null;
  dispatched_at?: string | null;
  delivered_at?: string | null;
  ready_at?: string | null;
  freight_cost?: number | null;
  freight_currency?: string | null;
  received_by_name?: string | null;
  is_backorder?: boolean | null;
  backorder_of_number?: string | null;

  // Statement-specific
  statement_transactions?: StatementTransaction[];
  statement_aging?: StatementAgingBucket[];
  statement_opening_balance?: number;
  statement_closing_balance?: number;
  statement_period_start?: string;
  statement_period_end?: string;

  // POS receipt-specific (Fix 3 — keep on-screen preview & printed bytes
  // sourced from the SAME canonical fields, no second template surface).
  cashier_name?: string | null;
  register_id?: string | null;
  register_name?: string | null;
  pos_payments?: Array<{ payment_method: string; amount: number; reference?: string | null }>;
  etims_cu_number?: string | null;
  etims_qr_data?: string | null;
  is_voided?: boolean;
  is_refund?: boolean;
  original_transaction_number?: string | null;

  /**
   * Stage X7 — merged ExtendedReceiptSettings for POS receipts.
   * Populated by `fetchPOSReceipt` (snapshot first, live fallback) and
   * consumed by the Line[] receipt engine to gate/format every section. Other
   * document types leave this undefined.
   */
  // deno-lint-ignore no-explicit-any
  pos_receipt_settings?: Record<string, any> | null;

  // ── Customer-payment receipt: per-invoice allocation breakdown ──
  // Populated by `fetchReceipt` whenever `payment_allocations` rows exist
  // for the resolved payment. Empty / undefined means a legacy single-
  // invoice payment or an unallocated on-account advance — renderers fall
  // back to today's behaviour in that case.
  payment_allocations?: Array<{
    invoice_id: string;
    invoice_number: string;
    invoice_date: string | null;
    invoice_total: number;
    amount_applied: number;
    balance_after: number;
    currency: string;
  }>;
  /** Sum of `payment.amount - sum(allocations)`. Surfaced as "Unapplied advance". */
  unapplied_amount?: number;
  /** Original payment reference / external txn id (cheque #, M-Pesa code, etc.). */
  payment_reference?: string | null;
}

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_TEMPLATE_SETTINGS: TemplateSettings = {
  show_company_name: true,
  show_company_address: true,
  show_company_phone: true,
  show_company_email: true,
  show_tax_id: false,
  header_text: null,
  document_title_format: 'INVOICE',

  show_line_numbers: true,
  show_item_sku: false,
  show_item_description: true,
  show_unit_price: true,
  show_quantity: true,
  show_tax_column: true,
  show_discount_column: false,

  show_subtotal: true,
  show_discount_total: true,
  show_tax_breakdown: true,
  show_total_in_words: false,
  totals_position: 'right',

  show_payment_instructions: true,
  payment_instructions: null,
  bank_details: {},
  show_bank_details: true,
  footer_text: null,
  show_signature_line: false,
  signature_label: 'Authorized Signature',
  show_terms: true,
  terms_text: null,

  show_payment_methods: true,
  payment_method_ids: [],

  show_status_badge: false,
  watermark_text: null,
  watermark_opacity: 0.1,

  // Legacy fields — ignored by the unified PDF engine, preserved on the
  // type for DB compatibility. See docs/reporting-stage-d.md.
  logo_position: 'top-left',
  logo_size: 'medium',
  primary_color: '#1a1a2e',
  secondary_color: '#6b7280',
  accent_color: '#3b82f6',
  font_family: "'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  font_size_base: 14,
  background_color: '#ffffff',
  custom_css: null,
};

// ── Utility: number → words (used by total-in-words renderer) ──────────────

export function numberToWords(num: number): string {
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];

  if (num === 0) return 'zero';
  if (num < 10) return ones[num];
  if (num < 20) return teens[num - 10];
  if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '');
  if (num < 1000) return ones[Math.floor(num / 100)] + ' hundred' + (num % 100 ? ' and ' + numberToWords(num % 100) : '');
  if (num < 1000000) return numberToWords(Math.floor(num / 1000)) + ' thousand' + (num % 1000 ? ' ' + numberToWords(num % 1000) : '');
  return numberToWords(Math.floor(num / 1000000)) + ' million' + (num % 1000000 ? ' ' + numberToWords(num % 1000000) : '');
}

// ── Data Fetching Helpers ──────────────────────────────────────────────────

/**
 * Fetch custom field values for a given entity from the database.
 */
export async function fetchCustomFields(
  // deno-lint-ignore no-explicit-any
  supabaseClient: any,
  organizationId: string,
  entityType: string,
  entityId: string,
): Promise<CustomField[]> {
  try {
    const { data: fieldConfigs } = await supabaseClient
      .from("entity_field_configs")
      .select("id, field_key, field_label, field_type, display_order, document_section")
      .eq("organization_id", organizationId)
      .eq("entity_type", entityType)
      .eq("is_visible", true)
      .order("display_order");

    if (!fieldConfigs || fieldConfigs.length === 0) return [];

    const { data: fieldValues } = await supabaseClient
      .from("entity_field_values")
      .select("field_key, field_value")
      .eq("organization_id", organizationId)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId);

    // deno-lint-ignore no-explicit-any
    const valuesMap = new Map((fieldValues || []).map((v: any) => [v.field_key, v.field_value]));
    return fieldConfigs
      // deno-lint-ignore no-explicit-any
      .filter((fc: any) => valuesMap.has(fc.field_key) && valuesMap.get(fc.field_key))
      // deno-lint-ignore no-explicit-any
      .map((fc: any) => ({
        field_label: fc.field_label,
        field_value: valuesMap.get(fc.field_key) || null,
        field_type: fc.field_type,
        document_section: fc.document_section || 'additional',
      }));
  } catch (err) {
    console.error(`Custom fields fetch error for ${entityType} (continuing without them):`, err);
    return [];
  }
}

/**
 * Fetch the active default document template for an organization.
 * Falls back to org-level template if no business-specific template found.
 */
export async function fetchTemplate(
  // deno-lint-ignore no-explicit-any
  supabaseClient: any,
  organizationId: string,
  templateType: string,
  businessId?: string | null,
): Promise<TemplateSettings> {
  try {
    if (businessId) {
      const { data: bizTemplate } = await supabaseClient
        .from("document_templates")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("template_type", templateType)
        .eq("is_active", true)
        .eq("is_default", true)
        .eq("business_id", businessId)
        .maybeSingle();

      if (bizTemplate) {
        console.log("Using business template:", bizTemplate.template_name);
        return { ...DEFAULT_TEMPLATE_SETTINGS, ...bizTemplate };
      }
    }

    const { data: orgTemplate } = await supabaseClient
      .from("document_templates")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("template_type", templateType)
      .eq("is_active", true)
      .eq("is_default", true)
      .is("business_id", null)
      .maybeSingle();

    if (orgTemplate) {
      console.log("Using organization template:", orgTemplate.template_name);
      return { ...DEFAULT_TEMPLATE_SETTINGS, ...orgTemplate };
    }
  } catch (err) {
    console.error("Template fetch error (using default):", err);
  }

  console.log("Using default template");
  return { ...DEFAULT_TEMPLATE_SETTINGS };
}
