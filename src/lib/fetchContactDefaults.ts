/**
 * Fetches accounting-relevant defaults from a contact record.
 * Used by invoice, bill, and sales order creation to auto-populate
 * payment terms, tax rates, and other contact-level settings.
 */
import { supabase } from "@/integrations/supabase/client";

export interface ContactDefaults {
  payment_term_id: string | null;
  default_receivable_account_id: string | null;
  default_payable_account_id: string | null;
  default_expense_account_id: string | null;
  default_tax_rate_id: string | null;
  withholding_tax_rate: number | null;
  tax_exemption_number: string | null;
  credit_hold: boolean | null;
  credit_limit: number | null;
  default_currency: string | null;
  default_payment_method_id: string | null;
  opening_balance: number | null;
}

const EMPTY_DEFAULTS: ContactDefaults = {
  payment_term_id: null,
  default_receivable_account_id: null,
  default_payable_account_id: null,
  default_expense_account_id: null,
  default_tax_rate_id: null,
  withholding_tax_rate: null,
  tax_exemption_number: null,
  credit_hold: null,
  credit_limit: null,
  default_currency: null,
  default_payment_method_id: null,
  opening_balance: null,
};

/**
 * Fetch all accounting defaults for a contact in a single query.
 * Returns empty defaults if contactId is null or contact not found.
 */
export async function fetchContactDefaults(contactId: string | null): Promise<ContactDefaults> {
  if (!contactId) return EMPTY_DEFAULTS;

  const { data, error } = await supabase
    .from("contacts")
    .select(
      "payment_term_id, default_receivable_account_id, default_payable_account_id, default_expense_account_id, default_tax_rate_id, withholding_tax_rate, tax_exemption_number, credit_hold, credit_limit, default_currency, default_payment_method_id, opening_balance"
    )
    .eq("id", contactId)
    .maybeSingle();

  if (error || !data) return EMPTY_DEFAULTS;

  return {
    payment_term_id: data.payment_term_id ?? null,
    default_receivable_account_id: data.default_receivable_account_id ?? null,
    default_payable_account_id: data.default_payable_account_id ?? null,
    default_expense_account_id: data.default_expense_account_id ?? null,
    default_tax_rate_id: data.default_tax_rate_id ?? null,
    withholding_tax_rate: data.withholding_tax_rate ?? null,
    tax_exemption_number: data.tax_exemption_number ?? null,
    credit_hold: data.credit_hold ?? null,
    credit_limit: data.credit_limit ?? null,
    default_currency: data.default_currency ?? null,
    default_payment_method_id: data.default_payment_method_id ?? null,
    opening_balance: data.opening_balance ?? null,
  };
}
