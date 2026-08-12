/**
 * Supplier feature slice ↔ schema contract guard.
 *
 * Two drifts took the Suppliers workbench down at once:
 *   1. reads asked PostgREST for `contacts.tax_number` — the party's tax
 *      identity column is `tax_id` (ADR-0079), so the whole embed 400'd;
 *   2. writes used the dead lifecycle vocabulary (`prospect`, `qualified`,
 *      `active`, `retired`), which the `suppliers_lifecycle_state_check`
 *      CHECK constraint rejects.
 *
 * These assertions fail in CI instead of on the landing page.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const SLICE = join(process.cwd(), "src/features/purchases/suppliers");

/** The only states `suppliers.lifecycle_state` accepts. */
const ALLOWED_STATES = [
  "draft",
  "qualifying",
  "approved",
  "suspended",
  "blocked",
  "archived",
] as const;

const DEAD_STATES = ["prospect", "qualified", "active", "retired"] as const;

function sliceFiles(): { name: string; source: string }[] {
  return readdirSync(SLICE)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((name) => ({ name, source: readFileSync(join(SLICE, name), "utf8") }));
}

describe("supplier slice ↔ schema contract", () => {
  it("never references contacts.tax_number (tax identity is contacts.tax_id)", () => {
    const offenders = sliceFiles()
      .filter((f) => f.source.includes("tax_number"))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it("only uses lifecycle states permitted by the CHECK constraint", () => {
    const offenders: string[] = [];
    for (const { name, source } of sliceFiles()) {
      for (const dead of DEAD_STATES) {
        // Only flag the state used as a lifecycle_state value/comparison,
        // e.g. lifecycle_state === "active" or lifecycle_state: "prospect".
        const asValue = new RegExp(
          `lifecycle_state[^\\n]{0,20}["']${dead}["']`,
        );
        if (asValue.test(source)) offenders.push(`${name}: ${dead}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("creates suppliers through the server-authoritative RPC, not direct inserts", () => {
    const create = readFileSync(join(SLICE, "SupplierCreatePage.tsx"), "utf8");
    expect(create).toContain("createSupplier");
    expect(create).not.toMatch(/\.from\(["']suppliers["']\)[\s\S]{0,80}\.insert/);
    expect(create).not.toMatch(/\.from\(["']contacts["']\)[\s\S]{0,80}\.insert/);
  });

  it("documents the full allowed state set", () => {
    const hook = readFileSync(join(SLICE, "useSuppliers.ts"), "utf8");
    for (const state of ALLOWED_STATES) {
      expect(hook).toContain(`"${state}"`);
    }
  });
});
