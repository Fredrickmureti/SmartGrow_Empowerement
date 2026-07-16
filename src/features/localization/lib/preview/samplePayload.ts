/**
 * Country-agnostic synthetic sample rows shared by every localization
 * preview renderer. Consolidates the previously duplicated payload
 * fixtures in `ReturnFormatPreview`, `PreviewPanel`, and the
 * country-locked `keReturnFixture` (Phase B of the preview
 * consolidation — see .lovable/plan.md).
 *
 * These rows are pure fixtures — no PII, no country-specific PIN
 * formats, no statute names. Publishers previewing a Ghana or SA pack
 * see the same "Employee A/B/C" identifiers as a KE pack.
 */

export interface SamplePayrollRow {
  employee: {
    full_name: string;
    tax_pin: string;
    national_id: string;
    employee_number: string;
  };
  sum_employee_amount: number;
  sum_employer_amount: number;
  sum_gross_amount: number;
  sum_taxable_amount: number;
  sum_total_amount: number;
  count_payslips: number;
}

export const SAMPLE_PAYROLL_ROWS: SamplePayrollRow[] = [
  {
    employee: {
      full_name: "Employee A (sample)",
      tax_pin: "SAMPLE-PIN-0001",
      national_id: "SAMPLE-ID-0001",
      employee_number: "EMP-001",
    },
    sum_employee_amount: 45200,
    sum_employer_amount: 2160,
    sum_gross_amount: 100000,
    sum_taxable_amount: 95000,
    sum_total_amount: 47360,
    count_payslips: 1,
  },
  {
    employee: {
      full_name: "Employee B (sample)",
      tax_pin: "SAMPLE-PIN-0002",
      national_id: "SAMPLE-ID-0002",
      employee_number: "EMP-002",
    },
    sum_employee_amount: 32450,
    sum_employer_amount: 2160,
    sum_gross_amount: 82000,
    sum_taxable_amount: 78000,
    sum_total_amount: 34610,
    count_payslips: 1,
  },
  {
    employee: {
      full_name: "Employee C (sample)",
      tax_pin: "SAMPLE-PIN-0003",
      national_id: "SAMPLE-ID-0003",
      employee_number: "EMP-003",
    },
    sum_employee_amount: 27100,
    sum_employer_amount: 2160,
    sum_gross_amount: 71000,
    sum_taxable_amount: 68000,
    sum_total_amount: 29260,
    count_payslips: 1,
  },
];

export const SAMPLE_PERIOD = {
  start: "2026-05-01",
  end: "2026-05-31",
  label: "May 2026 (sample)",
} as const;

export function resolveSamplePath(ctx: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: any = ctx;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
