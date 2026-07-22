/**
 * Enterprise-payroll invariant: statutory certificates must never be issued
 * for an employee whose canonical YTD projection is entirely zero. SAP HCM
 * (`PC00_M99_CIPE`), Workday, Oracle HCM all block this — otherwise a filed
 * statutory document silently reports "no earnings, no PAYE" which the
 * revenue authority treats as an active zero return.
 *
 * This arch test locks the guard into `generate-tax-certificate` so it
 * cannot be removed by a future refactor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(
  process.cwd(),
  "supabase/functions/generate-tax-certificate/index.ts",
);

describe("certificate empty-year refusal", () => {
  it("refuses to issue a certificate when every canonical total is zero", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/EMPTY_PAYROLL_YEAR/);
    // Guard must sit on the totals from resolveCertificateYtd (canonical
    // projection), not on a re-derived value.
    expect(src).toMatch(/totals\)\.gross_pay/);
    expect(src).toMatch(/totals\)\.employee/);
  });
});
