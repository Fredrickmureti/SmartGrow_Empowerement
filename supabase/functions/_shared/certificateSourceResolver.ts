// @ts-nocheck — Deno runtime
/**
 * certificateSourceResolver — single writer for statutory-certificate YTD
 * reads (ADR 0060). Every certificate generation path MUST resolve figures
 * through this helper so we can guarantee that P9A / Certificate of
 * Service / any future country's annual employee statement all agree with
 * the canonical `payroll_employee_ytd` projection and never re-sum raw
 * `payslip_lines` inline.
 *
 * Callers:
 *   - supabase/functions/generate-tax-certificate/index.ts
 *
 * If a new caller shows up, add it to the ROOTS list in
 * `src/test/architecture/certificate-canonical-source.test.ts` and make
 * sure it flows through here.
 */

export interface CertificateRollupRow {
  rule_code: string;
  category: string | null;
  employee_amount: number;
  employer_amount: number;
  taxable_amount: number;
}

export interface CertificateTotals {
  employee: number;
  employer: number;
  taxable: number;
}

export interface CertificateProvenance {
  run_ids: string[];
  payslip_ids: string[];
  max_payroll_updated_at: string;
  snapshot_at: string;
}

export interface CertificateSource {
  rows: CertificateRollupRow[];
  totals: CertificateTotals;
  provenance: CertificateProvenance;
}

/**
 * Resolve the canonical YTD projection for one (employee, fiscal_year).
 *
 * Reads:
 *   - payroll_employee_ytd_rollup (RPC) — the ONLY numeric source
 *   - payroll_runs / payslips              — provenance high-water mark
 *
 * Does NOT read `payslip_lines` directly; ESLint + arch test enforce this.
 */
export async function resolveCertificateYtd(params: {
  admin: any;
  organizationId: string;
  businessId: string;
  employeeId: string;
  fiscalYear: number;
}): Promise<CertificateSource> {
  const { admin, organizationId, businessId, employeeId, fiscalYear } = params;

  const { data: rollup, error: rollErr } = await admin.rpc(
    "payroll_employee_ytd_rollup",
    { p_year: fiscalYear, p_employee_id: employeeId },
  );
  if (rollErr) throw new Error(rollErr.message);
  const rows = ((rollup ?? []) as CertificateRollupRow[]).map((r) => ({
    rule_code: r.rule_code,
    category: r.category,
    employee_amount: Number(r.employee_amount) || 0,
    employer_amount: Number(r.employer_amount) || 0,
    taxable_amount: Number(r.taxable_amount) || 0,
  }));

  const totals = rows.reduce<CertificateTotals>(
    (acc, r) => {
      acc.employee += r.employee_amount;
      acc.employer += r.employer_amount;
      acc.taxable += r.taxable_amount;
      return acc;
    },
    { employee: 0, employer: 0, taxable: 0 },
  );

  // Provenance: capture the high-water mark of every run/payslip that fed
  // this employee's YTD projection for this fiscal year. Used by
  // `payroll_mark_stale_certificates` to flip `stale=true` when the
  // upstream payroll surface mutates after issuance.
  const { data: runRows } = await admin
    .from("payroll_runs")
    .select("id, updated_at, pay_period_end")
    .eq("organization_id", organizationId)
    .eq("business_id", businessId);
  const fyRuns = (runRows ?? []).filter(
    (r: any) =>
      r.pay_period_end &&
      new Date(r.pay_period_end).getUTCFullYear() === fiscalYear,
  );
  const runIds = fyRuns.map((r: any) => r.id);
  const { data: slipRows } = await admin
    .from("payslips")
    .select("id, updated_at, payroll_run_id")
    .eq("organization_id", organizationId)
    .eq("business_id", businessId)
    .eq("employee_id", employeeId)
    .in(
      "payroll_run_id",
      runIds.length ? runIds : ["00000000-0000-0000-0000-000000000000"],
    );
  const maxRunTs = fyRuns.reduce(
    (m: number, r: any) => Math.max(m, new Date(r.updated_at).getTime()),
    0,
  );
  const maxSlipTs = (slipRows ?? []).reduce(
    (m: number, r: any) => Math.max(m, new Date(r.updated_at).getTime()),
    0,
  );

  return {
    rows,
    totals,
    provenance: {
      run_ids: runIds,
      payslip_ids: (slipRows ?? []).map((r: any) => r.id),
      max_payroll_updated_at: new Date(
        Math.max(maxRunTs, maxSlipTs, 0),
      ).toISOString(),
      snapshot_at: new Date().toISOString(),
    },
  };
}