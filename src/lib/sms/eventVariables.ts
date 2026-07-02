/**
 * Per-SMS-event variable catalog.
 *
 * Single source of truth for which `{{variables}}` are available to a given
 * event template, used by:
 *  - the template editor (insert chips, validation, preview)
 *  - the database triggers (which populate the same keys when enqueueing
 *    sms_event_outbox rows)
 *  - the test-send / preview that substitutes the `sample` values
 */

import type { Database } from "@/integrations/supabase/types";

export type SmsEventType = Database["public"]["Enums"]["sms_event_type"];

export interface SmsVariable {
  key: string;
  label: string;
  sample: string;
}

const COMMON: SmsVariable[] = [
  { key: "company_name", label: "Company name", sample: "Acme Co." },
  { key: "branch_name", label: "Branch name", sample: "Main Branch" },
];

const CUSTOMER: SmsVariable[] = [
  { key: "customer_name", label: "Customer name", sample: "Jane Doe" },
];

const VENDOR: SmsVariable[] = [
  { key: "vendor_name", label: "Vendor name", sample: "Supplier Ltd" },
];

const EMPLOYEE: SmsVariable[] = [
  { key: "employee_name", label: "Employee name", sample: "John Smith" },
];

export const SMS_EVENT_VARIABLES: Record<SmsEventType, SmsVariable[]> = {
  invoice_posted: [
    ...CUSTOMER,
    { key: "invoice_number", label: "Invoice #", sample: "INV-00042" },
    { key: "amount", label: "Total amount", sample: "12,500.00" },
    { key: "due_date", label: "Due date", sample: "2026-05-15" },
    ...COMMON,
  ],
  payment_received: [
    ...CUSTOMER,
    { key: "amount", label: "Amount paid", sample: "5,000.00" },
    { key: "invoice_number", label: "Invoice #", sample: "INV-00042" },
    { key: "balance", label: "Remaining balance", sample: "0.00" },
    ...COMMON,
  ],
  invoice_overdue: [
    ...CUSTOMER,
    { key: "invoice_number", label: "Invoice #", sample: "INV-00042" },
    { key: "amount", label: "Amount due", sample: "12,500.00" },
    { key: "days_overdue", label: "Days overdue", sample: "7" },
    ...COMMON,
  ],
  payment_reminder: [
    ...CUSTOMER,
    { key: "invoice_number", label: "Invoice #", sample: "INV-00042" },
    { key: "amount", label: "Amount due", sample: "12,500.00" },
    { key: "due_date", label: "Due date", sample: "2026-05-15" },
    ...COMMON,
  ],
  estimate_sent: [
    ...CUSTOMER,
    { key: "estimate_number", label: "Estimate #", sample: "EST-0007" },
    { key: "amount", label: "Estimate total", sample: "8,200.00" },
    ...COMMON,
  ],
  sales_order_confirmed: [
    ...CUSTOMER,
    { key: "order_number", label: "Order #", sample: "SO-0019" },
    { key: "amount", label: "Order total", sample: "8,200.00" },
    ...COMMON,
  ],
  delivery_shipped: [
    ...CUSTOMER,
    { key: "delivery_number", label: "Delivery #", sample: "DN-0011" },
    { key: "tracking", label: "Tracking", sample: "TRK123" },
    ...COMMON,
  ],
  credit_note_issued: [
    ...CUSTOMER,
    { key: "credit_note_number", label: "Credit note #", sample: "CN-0003" },
    { key: "amount", label: "Credit amount", sample: "1,200.00" },
    ...COMMON,
  ],
  recurring_invoice_generated: [
    ...CUSTOMER,
    { key: "invoice_number", label: "Invoice #", sample: "INV-00043" },
    { key: "amount", label: "Total amount", sample: "12,500.00" },
    ...COMMON,
  ],
  customer_statement_sent: [
    ...CUSTOMER,
    { key: "balance", label: "Statement balance", sample: "12,500.00" },
    { key: "period", label: "Period", sample: "April 2026" },
    ...COMMON,
  ],
  po_sent: [
    ...VENDOR,
    { key: "po_number", label: "PO #", sample: "PO-0012" },
    { key: "amount", label: "PO total", sample: "30,000.00" },
    ...COMMON,
  ],
  expense_approved: [
    ...EMPLOYEE,
    { key: "expense_number", label: "Expense #", sample: "EXP-0021" },
    { key: "amount", label: "Approved amount", sample: "240.00" },
    ...COMMON,
  ],
  expense_rejected: [
    ...EMPLOYEE,
    { key: "expense_number", label: "Expense #", sample: "EXP-0021" },
    { key: "reason", label: "Rejection reason", sample: "Missing receipt" },
    ...COMMON,
  ],
  payroll_processed: [
    ...EMPLOYEE,
    { key: "period", label: "Pay period", sample: "April 2026" },
    { key: "amount", label: "Net pay", sample: "75,000.00" },
    ...COMMON,
  ],
  low_stock_alert: [
    { key: "count", label: "Low-stock product count", sample: "3" },
    { key: "sample_products", label: "Sample product names", sample: "Widget A, Widget B" },
    ...COMMON,
  ],
  out_of_stock: [
    { key: "product_name", label: "Product name", sample: "Widget A" },
    { key: "sku", label: "SKU", sample: "WDG-001" },
    ...COMMON,
  ],
};

/** Render a template using the catalog's sample values (for previews). */
export function renderTemplatePreview(eventType: SmsEventType | string, body: string): string {
  const vars = (SMS_EVENT_VARIABLES as Record<string, SmsVariable[]>)[eventType] || [];
  const samples: Record<string, string> = {};
  for (const v of vars) samples[v.key] = v.sample;
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => samples[k] ?? `{{${k}}}`);
}

/** Find variables referenced in the body that aren't defined for this event. */
export function findUnknownVariables(eventType: SmsEventType | string, body: string): string[] {
  const vars = (SMS_EVENT_VARIABLES as Record<string, SmsVariable[]>)[eventType] || [];
  const known = new Set(vars.map((v) => v.key));
  const found = new Set<string>();
  body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    if (!known.has(k)) found.add(k);
    return _;
  });
  return [...found];
}