/**
 * Tax Certificate subsystem architecture guards (ADR 0036 addendum).
 *
 * Pins the lifecycle/provenance/permission/submission contracts established
 * in `.lovable/plan.md` Steps 1–7. A regression here means certificates can
 * silently drift from payroll truth, escape permission gates, or fall out
 * of the submission ledger — all audit-grade failures.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GEN = readFileSync(
  join(process.cwd(), "supabase", "functions", "generate-tax-certificate", "index.ts"),
  "utf8",
);
const DOWNLOAD = readFileSync(
  join(process.cwd(), "supabase", "functions", "download-tax-certificate", "index.ts"),
  "utf8",
);
const RECORD = readFileSync(
  join(process.cwd(), "supabase", "functions", "record-return-filing", "index.ts"),
  "utf8",
);

describe("tax certificate lifecycle invariants", () => {
  it("generate gates on payroll.write, not financials.write", () => {
    expect(GEN).toMatch(/_module:\s*["']payroll["']/);
    expect(GEN).toMatch(/_operation:\s*["']write["']/);
    expect(GEN).not.toMatch(/_module:\s*["']financials["']/);
  });

  it("generate resolves the active pack via the canonical view", () => {
    expect(GEN).toMatch(/v_org_active_localization_pack/);
  });

  it("Certificate of Service is sourced from employment facts, not payroll YTD", () => {
    expect(GEN).toMatch(/isCertificateOfServiceTemplate/);
    expect(GEN).toMatch(/employee_service_record/);
    expect(GEN).toMatch(/!isServiceCertificate\s*&&\s*!rows\.length/);
  });

  it("download writes a lifecycle 'downloaded' event", () => {
    expect(DOWNLOAD).toMatch(/payroll_tax_certificate_events/);
    expect(DOWNLOAD).toMatch(/downloaded/);
  });

  it("record-return-filing joins certificates to submissions", () => {
    expect(RECORD).toMatch(/payroll_tax_certificate_submissions/);
  });
});