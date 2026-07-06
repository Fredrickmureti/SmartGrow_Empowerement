// @ts-nocheck — Deno runtime
/**
 * Synthetic certificate payload used by `lint-localization-pack` as the
 * B3 visual-QA gate. Kept intentionally small (one employee, 12 months
 * of posted lines, YTD totals) — its only job is to exercise every
 * section renderer so we can catch templates that would produce a
 * shallow / broken PDF at runtime.
 *
 * Country-agnostic: no rule codes are baked in; the caller wires
 * `ytdRows` from the template's own rules so the fixture works for any
 * pack.
 */
import type { CertificatePayload } from "./pdf/certificateRenderer.ts";

export function buildLintFixture(ruleCodes: string[]): CertificatePayload {
  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    basic_pay: 120_000,
    allowances: 30_000,
    gross: 150_000,
    taxable: 145_000,
    employee_deductions: 25_000,
    employer_contributions: 8_000,
    net: 120_000,
    rules: Object.fromEntries(
      ruleCodes.map((c) => [c, { employee: 5_000, employer: 1_500, taxable: 145_000 }]),
    ),
  }));
  const ytdRows = ruleCodes.length
    ? ruleCodes.map((rule_code) => ({
        rule_code,
        category: "statutory",
        employee_amount: 60_000,
        employer_amount: 18_000,
        taxable_amount: 1_740_000,
      }))
    : [{ rule_code: "PAYE", category: "tax", employee_amount: 300_000, employer_amount: 0, taxable_amount: 1_740_000 }];
  return {
    employee: {
      id: "fixture-employee",
      full_name: "Fixture Employee",
      employee_number: "EMP-0001",
      tax_pin: "A000000000A",
      national_id: "00000000",
      position: "Analyst",
      department: "Finance",
      hire_date: "2020-01-01",
    },
    employer: {
      name: "Fixture Employer Ltd",
      tax_pin: "P000000000P",
      address: "PO Box 0000, Nairobi",
      tax_office: "Nairobi North",
    },
    fiscal_year: new Date().getFullYear() - 1,
    period_label: "January – December",
    currency: "KES",
    monthly,
    ytdRows,
    totals: {
      employee: ytdRows.reduce((s, r) => s + r.employee_amount, 0),
      employer: ytdRows.reduce((s, r) => s + r.employer_amount, 0),
      taxable: 1_740_000,
    },
    serial_number: "LINT-FIXTURE",
    generated_at: new Date().toISOString(),
  };
}

/**
 * Minimum byte floor per doc class. If a rendered certificate PDF falls
 * below this, the template is almost certainly missing sections (empty
 * bodies compress to ~1.5 KB from pdf-lib overhead alone).
 */
export function byteFloorFor(templateCode: string): number {
  const c = String(templateCode ?? "").toUpperCase();
  if (c.startsWith("P9")) return 6_000;
  if (c.startsWith("P10")) return 4_000;
  if (c.startsWith("CERT_OF_SERVICE") || c.startsWith("CERTIFICATE_OF_SERVICE")) return 3_000;
  return 2_500; // generic floor — a section-based cert is never < 2.5 KB
}
