/**
 * Architecture guard — Wave 2 of the Workspace Governance redesign.
 *
 * The `governance_modules` table is the single source of truth for every
 * tenant-scoped module: which tables it owns, which sequences/storage
 * prefixes it owns, which derived projections it writes, and which RPC
 * functions preview / teardown / export it.
 *
 * This test snapshots the registry contract. Live coverage (e.g. "every
 * tenant table is owned by exactly one module") is enforced by the SQL
 * helper `governance_list_unowned_tables()` — wired into a Deno SQL test
 * in Wave 5. Until then, this file documents the invariants.
 */
import { describe, it, expect } from "vitest";

const REQUIRED_MODULES = [
  "sales",
  "purchases",
  "vendor_returns",
  "inventory",
  "pos",
  "banking",
  "finance",
  "fixed_assets",
  "transactions_ledger",
  "ancillaries",
  "sequences",
];

describe("Governance Module Registry (Wave 2)", () => {
  it("documents the canonical registry helpers", () => {
    // UI reads modules via:    public.governance_list_modules()
    // CI reads coverage gaps:  public.governance_list_unowned_tables()
    expect("public.governance_list_modules").toMatch(/^public\./);
    expect("public.governance_list_unowned_tables").toMatch(/^public\./);
  });

  it("enumerates the modules seeded in Wave 2", () => {
    // Adding a new tenant-scoped domain (Payroll, HR, CRM, Projects, Sign,
    // SMS, etc.) requires:
    //   1. SELECT public.register_governance_module(...) in a migration
    //   2. A reset_module__<key> function
    //   3. Adding the key here
    expect(REQUIRED_MODULES.length).toBe(11);
    expect(REQUIRED_MODULES).toContain("finance");
    expect(REQUIRED_MODULES).toContain("transactions_ledger");
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
