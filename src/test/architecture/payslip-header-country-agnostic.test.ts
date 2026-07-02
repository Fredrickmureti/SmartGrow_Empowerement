/**
 * Guards the localization-aware payslip header against country drift.
 *
 * The payslip header model is the single contract consumed by:
 *   - supabase/functions/generate-payslip-pdf/index.ts  (PDF)
 *   - src/components/payroll/PayslipHeader.tsx          (Dialog + Portal)
 *
 * NONE of these files may name a country-specific statutory identifier.
 * Anything country-specific must come from `employee_statutory_identifiers`,
 * `organization_statutory_identifiers`, or `pack_requirements` rows
 * installed by a localization pack.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Country-specific identifier tokens — must never appear in renderer logic.
const FORBIDDEN = /\b(KRA[_\s-]?PIN|NSSF_NUMBER|SHIF_NUMBER|NHIF_NUMBER|NINO|UTR_NUMBER|EIN_NUMBER)\b/i;

const FILES = [
  "src/components/payroll/PayslipHeader.tsx",
  "src/lib/payroll/payslipHeader.ts",
  "src/components/payroll/PayslipDetailDialog.tsx",
  "src/components/payroll/EmployerStatutoryIdentifiersCard.tsx",
  "src/hooks/organization/useOrganizationStatutoryIdentifiers.ts",
  "src/pages/hr/payroll/sections.tsx",
  "supabase/functions/generate-payslip-pdf/index.ts",
];

describe("payslip header is country-agnostic", () => {
  for (const rel of FILES) {
    it(`${rel} contains no country-specific identifier tokens`, () => {
      const body = readFileSync(join(process.cwd(), rel), "utf8");
      // Strip block + line comments before scanning so "(KRA PIN)" in
      // explanatory prose can't trip the guard.
      const stripped = body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(stripped, `Forbidden token in ${rel}`).not.toMatch(FORBIDDEN);
    });
  }
});
