/**
 * ADR 0060 §6 — Structural + metadata contract for return templates.
 *
 * Returns are aggregation specs consumed by the iTax / portal-upload
 * builders. They have their own contract (columns[] + filters + totals),
 * distinct from the section-based certificate contract. This test
 * asserts:
 *
 *  1. A DB trigger exists that enforces the contract at write time.
 *  2. The linter (`lint-localization-pack`) applies the SAME contract
 *     at publish time, using the returns-specific validator.
 *  3. No seed migration leaves a KE return template with the epoch
 *     `1900-01-01` effective_date that first shipped in the pack.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadMigrations(): string {
  const dir = "supabase/migrations";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n\n-- FILE BOUNDARY --\n\n");
}

describe("return template metadata contract (ADR 0060 §6)", () => {
  const sql = loadMigrations();

  it("registers a BEFORE trigger that enforces the returns column contract", () => {
    expect(sql).toMatch(/enforce_return_template_structure/);
    expect(sql).toMatch(/CREATE TRIGGER\s+trg_return_template_structure/);
    // Trigger source must mention the three body invariants.
    expect(sql).toMatch(/body\.columns must be a non-empty array/);
    expect(sql).toMatch(/body\.filters must specify rule_codes/);
    expect(sql).toMatch(/body\.totals must list the columns to sum/);
  });

  it("the linter validates returns with the column contract, not the cert section contract", () => {
    const linter = readFileSync(
      "supabase/functions/lint-localization-pack/index.ts",
      "utf8",
    );
    expect(linter).toMatch(/validateReturnStructure/);
    expect(linter).toMatch(/validateCertificateStructure/);
    // Returns validator must NOT require `body.sections`.
    const source = linter.split("validateReturnStructure")[1] ?? "";
    const returnFn = source.split("function ")[0];
    expect(returnFn).not.toMatch(/body\?\.sections/);
    expect(returnFn).toMatch(/body\?\.columns/);
  });

  it("no seed leaves a KE return template with the 1900-01-01 epoch date", () => {
    // The current pack migration set every KE return effective_date to
    // a real gazetted date. Any future seed that regresses to the
    // epoch will fail here.
    const bad = sql.match(
      /localization_pack_return_templates[\s\S]{0,4000}?effective_date[\s\S]{0,200}?DATE\s+'1900-01-01'/g,
    );
    // Only tolerated occurrences: the column default declared once at
    // table creation. That default should not appear inside an INSERT
    // or UPDATE targeting a specific return template.
    expect(bad ?? [], "found a seed writing 1900-01-01 to a return template").toHaveLength(0);
  });
});
