/**
 * Canonical customer-identity predicate.
 *
 * `contacts` has NO `contact_type` column. The vocabulary is:
 *   - `type`            — enum `contact_type` ∈ {customer, supplier, both}
 *   - `customer_rank`   — > 0 once the contact has transacted as a customer
 *   - `commercial_partner_id` — family rollup parent
 *
 * The enum's *type name* (`contact_type`) is not a column name. Referencing
 * `contact_type` as a column crashes PostgREST; referencing it as a JS
 * property silently yields `undefined`. Every customer-selection surface MUST
 * go through this module. Guarded by
 * `src/test/architecture/contact-identity-vocabulary.test.ts`.
 */

/** Contact `type` values that make a contact addressable as a customer. */
export const CUSTOMER_CONTACT_TYPES = ["customer", "both"] as const;

/**
 * PostgREST `.or()` filter: a contact is a customer if it is typed as one, or
 * if it has ever transacted as one (Odoo's `customer_rank` pattern).
 */
export const CUSTOMER_IDENTITY_OR_FILTER =
  "type.in.(customer,both),customer_rank.gt.0";

/** Client-side mirror of the same predicate, for already-fetched contacts. */
export function isCustomerContact(contact: {
  type?: string | null;
  customer_rank?: number | null;
}): boolean {
  const type = contact?.type ?? null;
  if (type && (CUSTOMER_CONTACT_TYPES as readonly string[]).includes(type)) {
    return true;
  }
  return (Number(contact?.customer_rank) || 0) > 0;
}
