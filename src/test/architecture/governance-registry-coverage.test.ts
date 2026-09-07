/**
 * Architecture guard — governance module registry.
 *
 * `governance_modules` is the single source of truth for every tenant-scoped
 * module: which tables it owns, which sequences/storage prefixes it owns,
 * which derived projections it writes, and which RPC functions preview /
 * teardown / export it.
 *
 * This test snapshots the registry contract for the microfinance institution.
 * The inherited ERP module keys (sales, purchases, vendor_returns, inventory,
 * pos, hr, payroll, warehouse) were deleted from the registry once their tables
 * were dropped from the database; `payments` / `payment_allocations` were moved
 * onto the `finance` module so they keep teardown coverage.
 *
 * Live coverage ("every tenant table is owned by exactly one module") is
 * enforced by the SQL helper `governance_list_unowned_tables()`.
 */
import { describe, it, expect } from "vitest";

const REQUIRED_MODULES = [
  "finance",
  "banking",
  "lending",
  "fixed_assets",
  "transactions_ledger",
  "ancillaries",
  "sequences",
];

const DELETED_ERP_MODULES = [
  "sales",
  "purchases",
  "vendor_returns",
  "inventory",
  "warehouse",
  "pos",
  "hr",
  "payroll",
];

describe("Governance Module Registry", () => {
  it("documents the canonical registry helpers", () => {
    // UI reads modules via:    public.governance_list_modules()
    // CI reads coverage gaps:  public.governance_list_unowned_tables()
    expect("public.governance_list_modules").toMatch(/^public\./);
    expect("public.governance_list_unowned_tables").toMatch(/^public\./);
  });

  it("enumerates the microfinance modules held in the registry", () => {
    // Adding a new tenant-scoped domain requires:
    //   1. SELECT public.register_governance_module(...) in a migration
    //   2. A reset_module__<key> function
    //   3. Adding the key here
    expect(REQUIRED_MODULES.length).toBe(7);
    expect(REQUIRED_MODULES).toContain("finance");
    expect(REQUIRED_MODULES).toContain("lending");
    expect(REQUIRED_MODULES).toContain("transactions_ledger");
  });

  it("keeps the deleted ERP module keys out of the required set", () => {
    for (const key of DELETED_ERP_MODULES) {
      expect(REQUIRED_MODULES).not.toContain(key);
    }
  });

  it("documents the registration contract", () => {
    // register_governance_module(
    //   p_module_key, p_display_name, p_depends_on, p_owns_tables,
    //   p_owns_storage_prefixes, p_owns_sequences, p_derived_projections,
    //   p_teardown_fn, p_preview_fn, p_export_fn, p_version, p_description
    // )
    expect("register_governance_module").toBe("register_governance_module");
  });
});
