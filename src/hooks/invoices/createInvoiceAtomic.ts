/**
 * Phase 6.2 — atomic invoice creation.
 *
 * Invoice creation used to be a two-step browser insert (header, then lines)
 * with client-computed totals and no retry protection: a failure between the
 * two inserts left a header with no lines, and a double submit created two
 * invoices with two numbers.
 *
 * `create_invoice_atomic` is now the single creation authority. The browser
 * states what the customer bought; the server resolves the base quantity,
 * recomputes every line's money, stamps the totals, the exchange rate and the
 * document number, and writes the header and the lines in one transaction.
 * The idempotency key makes a retry return the first invoice instead of a
 * second one.
 */
import { supabase } from "@/integrations/supabase/client";

export interface AtomicInvoiceHeader {
  organization_id: string;
  business_id: string;
  branch_id?: string | null;
  /**
   * Phase 6b — the warehouse this invoice draws stock from. Validated by
   * `resolve_sales_warehouse`; null lets the server take the branch default.
   */
  warehouse_id?: string | null;
  contact_id?: string | null;
  issue_date?: string | null;
  due_date?: string | null;
  notes?: string | null;
  terms?: string | null;
  discount_amount?: number | null;
  currency?: string | null;
  salesperson_id?: string | null;
  payment_term_id?: string | null;
  project_id?: string | null;
  source_estimate_id?: string | null;
  source_sales_order_id?: string | null;
  source_proforma_invoice_id?: string | null;
}

export interface AtomicInvoiceItem {
  product_id?: string | null;
  description?: string | null;
  /** Canonical base quantity, when the caller already holds it. */
  quantity?: number | null;
  /** What the customer actually ordered, in the unit they chose. */
  display_quantity?: number | null;
  display_uom_id?: string | null;
  packaging_id?: string | null;
  unit_price?: number | null;
  discount_percent?: number | null;
  tax_rate?: number | null;
  sort_order?: number | null;
  project_id?: string | null;
  task_id?: string | null;
  lot_number?: string | null;
  serial_number?: string | null;
}

export interface AtomicInvoiceResult {
  success: boolean;
  invoice_id: string;
  invoice_number: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  exchange_rate: number;
  item_count: number;
  idempotent_replay?: boolean;
}

/** A stable per-submission key, so a retry cannot create a second invoice. */
export function newInvoiceIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `inv-${crypto.randomUUID()}`;
  }
  return `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function createInvoiceAtomic(
  header: AtomicInvoiceHeader,
  items: AtomicInvoiceItem[],
  idempotencyKey?: string,
): Promise<AtomicInvoiceResult> {
  const { data, error } = await supabase.rpc("create_invoice_atomic", {
    p_header: header as unknown as never,
    p_items: items as unknown as never,
    p_idempotency_key: idempotencyKey ?? newInvoiceIdempotencyKey(),
  } as never);

  if (error) throw error;

  const result = data as unknown as AtomicInvoiceResult | null;
  if (!result?.invoice_id) {
    throw new Error("Invoice creation did not return an invoice");
  }
  return result;
}
