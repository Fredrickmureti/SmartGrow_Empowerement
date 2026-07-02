/**
 * Effective company-config resolver — typed wrapper around the SQL
 * function `public.get_effective_company_config(p_business_id, p_branch_id)`.
 *
 * Returns one merged view of the identity / branding fields a document
 * needs at render time, with explicit `source` provenance per field so
 * the UI can show "Inherited from {Company}" vs "Branch override" chips
 * and so audit logs record where a value came from.
 *
 * Resolution order (Odoo `res.company`-aligned):
 *   branch override (when branch_id is provided AND branch column non-null)
 *     → company value on `businesses`
 *     → null (no platform default for these identity fields)
 *
 * IMPORTANT: callers that render a SPECIFIC document (invoice, bill,
 * receipt, payslip) MUST pass the *record's* `business_id` and
 * `branch_id` — not the user's currently-selected business/branch.
 * A Nairobi-stamped invoice must always show the Nairobi branding,
 * even when the user is currently switched to Mombasa.
 */
import { supabase } from "@/integrations/supabase/client";

export type EffectiveSource = "branch_override" | "branch" | "business" | "organization" | "platform_default" | null;

export interface EffectiveField<T> {
  value: T | null;
  source: EffectiveSource;
}

export interface EffectiveCompanyConfig {
  business_id: string;
  branch_id: string | null;
  logo_url: EffectiveField<string>;
  invoice_prefix: EffectiveField<string>;
  estimate_prefix: EffectiveField<string>;
  bill_prefix: EffectiveField<string>;
  receipt_prefix: EffectiveField<string>;
  document_address: EffectiveField<string>;
  contact_email: EffectiveField<string>;
  contact_phone: EffectiveField<string>;
  receipt_header: EffectiveField<string>;
  receipt_footer: EffectiveField<string>;
  default_warehouse_id: EffectiveField<string>;
  base_currency: EffectiveField<string>;
  tax_id: EffectiveField<string>;
  fiscal_year_start: EffectiveField<string>;
  timezone: EffectiveField<string>;
}

/**
 * Call the SQL resolver. Returns null if the business does not exist
 * or the caller cannot read it (RLS).
 */
export async function getEffectiveCompanyConfig(
  businessId: string,
  branchId?: string | null,
): Promise<EffectiveCompanyConfig | null> {
  if (!businessId) return null;

  const { data, error } = await supabase.rpc("get_effective_company_config", {
    p_business_id: businessId,
    p_branch_id: branchId ?? undefined,
  });

  if (error) {
    console.warn("[getEffectiveCompanyConfig] RPC failed", error.message);
    return null;
  }
  if (!data || typeof data !== "object") return null;

  return data as unknown as EffectiveCompanyConfig;
}

/**
 * Convenience helper — pull a single resolved value plus its source.
 * Useful for inline UI like `effective(config, 'logo_url').value`.
 */
export function effective<K extends keyof EffectiveCompanyConfig>(
  cfg: EffectiveCompanyConfig | null,
  key: K,
): EffectiveCompanyConfig[K] extends EffectiveField<infer T>
  ? EffectiveField<T>
  : never {
  // deno-lint-ignore no-explicit-any
  return (cfg ? (cfg[key] as any) : { value: null, source: null }) as any;
}
