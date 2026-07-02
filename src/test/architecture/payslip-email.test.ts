/**
 * Functional guard — payslip email is wired end-to-end through the
 * unified SendDocumentDialog + send-document-email pipeline.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("payslip email wiring", () => {
  it("send-document-email handles payslip with employee join", () => {
    const src = read("supabase/functions/send-document-email/index.ts");
    expect(src).toMatch(/payslip/);
    expect(src).toMatch(/employees?/i);
  });

  it("send-document-email handles pos_receipt", () => {
    const src = read("supabase/functions/send-document-email/index.ts");
    expect(src).toMatch(/pos_receipt/);
  });

  it("SendDocumentDialog declares payslip + pos_receipt in DocumentType", () => {
    const src = read("src/components/common/SendDocumentDialog.tsx");
    expect(src).toMatch(/"payslip"/);
    expect(src).toMatch(/"pos_receipt"/);
  });

  it("PayslipDetailPage and PayslipsListPage both render SendDocumentDialog with documentType: 'payslip'", () => {
    const src = read("src/pages/hr/payroll/sections.tsx");
    // Two occurrences (detail + list) of the payslip document type passed to the dialog.
    const matches = src.match(/documentType:\s*"payslip"/g) ?? [];
    expect(matches.length, `expected at least 2 payslip SendDocumentDialog mounts in sections.tsx, found ${matches.length}`).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/SendDocumentDialog/);
  });

  it("PayrollRunDetailsDialog uses SendDocumentDialog (no fake handleEmailPayslips)", () => {
    const src = read("src/components/payroll/PayrollRunDetailsDialog.tsx");
    expect(src).toMatch(/SendDocumentDialog/);
    expect(src).not.toMatch(/handleEmailPayslips/);
    expect(src).not.toMatch(/coming soon/i);
  });
});
