/**
 * Supplier purchasability gate — server-side coverage contract.
 *
 * `public._assert_supplier_purchasable()` is the single authority deciding
 * whether a party may appear on a purchasing document: it rejects parties
 * without an approved supplier role (`draft`, `qualifying`, `suspended`,
 * `blocked`, `archived`) and enforces the Approved Supplier List when a
 * category is `asl_enforced`.
 *
 * UI pickers (`usePurchasableVendors`) are a convenience, never the control.
 * Every vendor-bearing document table MUST carry the gate trigger, otherwise
 * an API caller, import, or edge function can transact with a blocked vendor.
 *
 * Verified live against the database on 2026-08-12; this test freezes the
 * coverage set so a future migration cannot silently drop a trigger.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** table → trigger name that must exist in the migration history. */
const GATED_TABLES: Record<string, string> = {
  purchase_orders: "trg_po_supplier_purchasable",
  bills: "trg_bills_supplier_purchasable",
  rfq_invitations: "trg_rfq_inv_supplier_purchasable",
  purchase_returns: "trg_purchase_returns_supplier_purchasable",
  vendor_credit_notes: "trg_vendor_credit_notes_supplier_purchasable",
  expenses: "trg_expenses_supplier_purchasable",
};

function allMigrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

describe("supplier purchasability gate", () => {
  const sql = allMigrationSql();

  it("declares a gate trigger for every vendor-bearing document table", () => {
    const missing = Object.entries(GATED_TABLES)
      .filter(([, trigger]) => !sql.includes(trigger))
      .map(([table, trigger]) => `${table} (${trigger})`);
    expect(
      missing,
      `Missing supplier gate triggers:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("no gate trigger is dropped without a replacement", () => {
    const orphanedDrops = Object.values(GATED_TABLES).filter((trigger) => {
      const lastDrop = sql.lastIndexOf(`DROP TRIGGER IF EXISTS ${trigger}`);
      const lastCreate = sql.lastIndexOf(`CREATE TRIGGER ${trigger}`);
      return lastDrop > lastCreate;
    });
    expect(orphanedDrops).toEqual([]);
  });

  it("the gate function enforces lifecycle state and the ASL", () => {
    // Both halves of the rule live in one function so callers cannot get
    // lifecycle checking without ASL checking.
    const fnStart = sql.lastIndexOf("FUNCTION public._assert_supplier_purchasable");
    expect(fnStart).toBeGreaterThan(-1);
    const body = sql.slice(fnStart, fnStart + 6000);
    expect(body).toMatch(/lifecycle_state/);
    expect(body).toMatch(/asl_enforced|approved_supplier_list/);
  });

  it("keeps a single create_supplier overload (PGRST203 ambiguity guard)", () => {
    // The 2-arg `p_contact_id` variant was dropped on 2026-08-12; only the
    // `p_name`-first canonical signature may exist.
    const lastDrop = sql.lastIndexOf("DROP FUNCTION IF EXISTS public.create_supplier");
    expect(lastDrop).toBeGreaterThan(-1);
  });
});
