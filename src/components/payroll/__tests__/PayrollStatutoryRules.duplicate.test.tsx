/**
 * Static-source guard for the Odoo-parity "Duplicate as new version" row
 * action on payroll statutory rules.
 *
 * Contract: each rule row exposes a Duplicate icon button that opens the
 * editor as a brand-new rule, today's effective_from, the source row's
 * parameters cloned, and the `_inferred` marker stripped.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../pages/hr/PayrollStatutoryRules.tsx"),
  "utf8",
);

describe("PayrollStatutoryRules Duplicate row action", () => {
  it("defines an openDuplicateRule helper", () => {
    expect(SRC).toMatch(/function openDuplicateRule/);
  });

  it("seeds the duplicate with today's effective_from", () => {
    expect(SRC).toMatch(/effective_from:\s*today/);
    expect(SRC).toMatch(/format\(new Date\(\),\s*["']yyyy-MM-dd["']\)/);
  });

  it("strips the _inferred marker from cloned parameters", () => {
    expect(SRC).toMatch(/_inferred,\s*\.\.\.cleanParams/);
  });

  it("renders a Duplicate icon button bound to openDuplicateRule", () => {
    expect(SRC).toMatch(/onClick=\{\(\)\s*=>\s*openDuplicateRule\(rule\)\}/);
    expect(SRC).toMatch(/title="Duplicate as new version"/);
  });
});