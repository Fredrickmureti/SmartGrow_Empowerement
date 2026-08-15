/**
 * Sale-time tax — the ONE client seam (Phase 7).
 *
 * Tax on a Sales line is decided by the database:
 * `resolve_sales_line_tax(business, product, contact, date, tax_rate_id, rate)`
 * runs inside `_totals_normalize_line()` on every Sales line table, so whatever
 * a browser sends is re-derived before it is persisted.
 *
 * This module exists only so an editor can SHOW the rate the server is going to
 * apply. It calls the same resolver over RPC — it never reads `tax_rates` and
 * never re-implements the cascade (customer exemption > customer default >
 * product > company default, effective-dated as at the document date).
 *
 * Never treat the result as persisted truth: re-read the document after a write.
 */
import { supabase } from "@/integrations/supabase/client";

export interface SalesLineTaxPreview {
  /** Percentage rate, e.g. 16 for 16%. */
  rate: number;
  /** The tax rate actually applied, stamped on the line for audit. */
  tax_rate_id: string | null;
  /** True when the unit price is understood to already carry the tax. */
  is_inclusive: boolean;
  /** Per-unit fixed duty/levy, added on top of the percentage component. */
  fixed_amount: number;
  tax_type: string | null;
  /** Which rule decided the rate: customer_exempt | customer | product | … */
  source: string;
}

export interface SalesLineTaxArgs {
  businessId: string;
  /** Omit for a free-text line or for a "what would this customer pay?" preview. */
  productId?: string | null;
  contactId?: string | null;
  /** Document date — tax is resolved as at this date, not today. */
  date?: string | null;
  /** An explicitly chosen rate; validated server-side. */
  taxRateId?: string | null;
  /**
   * A rate typed on a free-text line. Leave undefined to ask the resolver what
   * the customer's applicable rate is.
   */
  requestedRate?: number | null;
}

export const ZERO_TAX_PREVIEW: SalesLineTaxPreview = {
  rate: 0,
  tax_rate_id: null,
  is_inclusive: false,
  fixed_amount: 0,
  tax_type: null,
  source: "none",
};

export async function previewSalesLineTax(
  args: SalesLineTaxArgs,
): Promise<SalesLineTaxPreview> {
  if (!args.businessId) return ZERO_TAX_PREVIEW;

  const { data, error } = await supabase.rpc("resolve_sales_line_tax", {
    p_business_id: args.businessId,
    p_product_id: args.productId ?? null,
    p_contact_id: args.contactId ?? null,
    p_date: args.date ?? new Date().toISOString().slice(0, 10),
    p_tax_rate_id: args.taxRateId ?? null,
    p_requested_rate: args.requestedRate ?? null,
  });
  if (error) throw error;

  const row = (data ?? {}) as Partial<SalesLineTaxPreview>;
  return {
    rate: Number(row.rate ?? 0),
    tax_rate_id: row.tax_rate_id ?? null,
    is_inclusive: Boolean(row.is_inclusive),
    fixed_amount: Number(row.fixed_amount ?? 0),
    tax_type: row.tax_type ?? null,
    source: row.source ?? "none",
  };
}

/**
 * The rate to pre-fill lines with when a customer is selected. Returns 0 for an
 * exempt customer — the resolver decides, not the caller.
 */
export async function previewCustomerTaxRate(
  businessId: string,
  contactId: string,
  date?: string | null,
): Promise<number> {
  const preview = await previewSalesLineTax({ businessId, contactId, date });
  return preview.rate;
}
