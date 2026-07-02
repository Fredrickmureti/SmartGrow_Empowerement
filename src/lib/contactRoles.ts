/**
 * Contact role helpers — the single place where rank flags and the legacy
 * `type` enum are reconciled.
 *
 * The platform is migrating from a single `type: customer|supplier|both`
 * enum to Odoo-style `customer_rank` / `supplier_rank` integers. While the
 * cross-module sweep (Sales/Purchases/Finance/CRM filters) is still in
 * flight, both representations must stay in lock-step:
 *
 *   - new writes: always send rank values AND the derived enum.
 *   - reads: prefer ranks, fall back to the enum for legacy rows
 *     whose ranks were never bumped above zero.
 *
 * Keep this module pure (no React, no Supabase) so it is trivially testable
 * and consumable from any layer — UI, importers, edge functions.
 */

export type ContactTypeEnum = "customer" | "supplier" | "both";

export interface ContactRoleFlags {
  isCustomer: boolean;
  isSupplier: boolean;
}

export interface ContactRoleRecord {
  type?: ContactTypeEnum | string | null;
  customer_rank?: number | null;
  supplier_rank?: number | null;
}

/** Derive boolean role flags from any contact-shaped record. */
export function rolesFromContact(c: ContactRoleRecord): ContactRoleFlags {
  const cr = Number(c.customer_rank ?? 0);
  const sr = Number(c.supplier_rank ?? 0);
  if (cr > 0 || sr > 0) {
    return { isCustomer: cr > 0, isSupplier: sr > 0 };
  }
  // Legacy fallback — rows predating the rank columns.
  switch (c.type) {
    case "supplier":
      return { isCustomer: false, isSupplier: true };
    case "both":
      return { isCustomer: true, isSupplier: true };
    case "customer":
    default:
      return { isCustomer: true, isSupplier: false };
  }
}

/** Derive the legacy enum from explicit role flags. */
export function typeFromRoles(flags: ContactRoleFlags): ContactTypeEnum {
  if (flags.isCustomer && flags.isSupplier) return "both";
  if (flags.isSupplier) return "supplier";
  return "customer";
}

/**
 * Compute the write-payload for ranks given the desired flags and the
 * currently-persisted ranks. Never overwrites a non-zero rank (those are
 * bumped by real transactions); only flips 0↔1 on user-driven changes.
 */
export function rankWritePayload(
  desired: ContactRoleFlags,
  current: { customer_rank?: number | null; supplier_rank?: number | null } = {},
): { customer_rank: number; supplier_rank: number } {
  const curC = Number(current.customer_rank ?? 0);
  const curS = Number(current.supplier_rank ?? 0);
  return {
    customer_rank: desired.isCustomer ? Math.max(1, curC) : 0,
    supplier_rank: desired.isSupplier ? Math.max(1, curS) : 0,
  };
}
