/**
 * Architecture guard — payroll lifecycle gate must be wired into every
 * generator that emits a filable artifact.
 *
 * The shared module `_shared/payrollLifecycleGate.ts` is the single writer
 * for these preconditions. If a future edit accidentally strips the call
 * site, tenants would silently be able to generate certificates or returns
 * from open / draft payroll periods — a compliance regression. This test
 * fails fast on that class of drift.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../../../", rel), "utf8");

describe("payroll lifecycle gate call sites", () => {
  it("generate-tax-certificate imports and calls requireApprovedRunsForYear", () => {
    const src = read("supabase/functions/generate-tax-certificate/index.ts");
    expect(src).toMatch(/from ["']\.\.\/_shared\/payrollLifecycleGate\.ts["']/);
    expect(src).toMatch(/requireApprovedRunsForYear\(/);
  });

  it("generate-statutory-return imports and calls requireClosedPeriod", () => {
    const src = read("supabase/functions/generate-statutory-return/index.ts");
    expect(src).toMatch(/from ["']\.\.\/_shared\/payrollLifecycleGate\.ts["']/);
    expect(src).toMatch(/requireClosedPeriod\(/);
  });
});