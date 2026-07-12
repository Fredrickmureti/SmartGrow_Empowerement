// @ts-nocheck — Deno runtime
/**
 * payrollLifecycleGate
 *
 * Enterprise-grade preconditions for any artifact that reads payroll history
 * (tax certificates, statutory returns, bank files, GL postings). Aligns with:
 *   - SAP HCM: PA30/PC00_M99_CIPE close gates
 *   - Workday: run status = "Complete"
 *   - Odoo Payroll: payslip.state = "done"
 *   - Oracle HCM Payroll: process locked to `Verified`/`Prepayments`
 *
 * The module exposes small, composable checks that return a
 * `{ ok, code, message, recovery, details }` shape so callers can map them
 * directly onto their `businessError()` helpers without leaking Postgres
 * error text to end users.
 */

type SupabaseAdmin = any;

export interface GateResult {
  ok: boolean;
  code?: string;
  message?: string;
  recovery?: string;
  details?: Record<string, unknown>;
}

const OK: GateResult = { ok: true };

/**
 * All payroll runs that touch (organization_id, business_id) in fiscal year
 * `fy` must have crossed the legal finalisation event:
 * `payroll_runs.approved_at IS NOT NULL`. Payment and GL posting remain peer
 * workflows and must not gate statutory documents.
 */
export async function requireApprovedRunsForYear(
  admin: SupabaseAdmin,
  args: { organization_id: string; business_id: string; fy: number },
): Promise<GateResult> {
  const start = `${args.fy}-01-01`;
  const end = `${args.fy}-12-31`;
  const { data, error } = await admin
    .from("payroll_runs")
    .select("id, status, approved_at, pay_period_start, pay_period_end")
    .eq("organization_id", args.organization_id)
    .eq("business_id", args.business_id)
    .gte("pay_period_start", start)
    .lte("pay_period_end", end)
    .is("approved_at", null);
  if (error) {
    return {
      ok: false,
      code: "LIFECYCLE_QUERY_FAILED",
      message: "Could not verify payroll run status for the requested year.",
      recovery: "Retry generation. If this repeats, ask an administrator to check payroll_runs access.",
      details: { detail: error.message, fy: args.fy },
    };
  }
  if ((data ?? []).length > 0) {
    return {
      ok: false,
      code: "PAYROLL_RUNS_NOT_APPROVED",
      message:
        `Fiscal year ${args.fy} still has payroll runs that have not been approved. ` +
        `Statutory documents can only be issued from a frozen payroll history.`,
      recovery:
        "Approve or reverse the pending runs, then regenerate. Go to Payroll → Runs and complete any Draft or Processing entries.",
      details: { pending_run_ids: data.map((r: any) => r.id).slice(0, 20), pending_count: data.length, fy: args.fy },
    };
  }
  return OK;
}

/**
 * The fiscal period covering `period_end` (or the exact `period_start`/`period_end`
 * pair for returns) must be in a state that permits filing artifacts to be
 * emitted. Currently only `closed`/`locked` periods are eligible; `draft` and
 * `open` periods would let payroll be re-run under the filed document.
 */
export async function requireClosedPeriod(
  admin: SupabaseAdmin,
  args: { organization_id: string; business_id: string; period_start: string; period_end: string },
): Promise<GateResult> {
  const { data, error } = await admin
    .from("payroll_periods")
    .select("id, status, start_date, end_date")
    .eq("organization_id", args.organization_id)
    .eq("business_id", args.business_id)
    .lte("start_date", args.period_start)
    .gte("end_date", args.period_end)
    .order("end_date", { ascending: false })
    .limit(1);
  if (error) {
    return {
      ok: false,
      code: "LIFECYCLE_QUERY_FAILED",
      message: "Could not verify payroll period status.",
      recovery: "Retry. If this repeats, ask an administrator to check payroll_periods access.",
      details: { detail: error.message },
    };
  }
  const row = (data ?? [])[0];
  if (!row) {
    // Tenants that have not operationalised `payroll_periods` yet still
    // need to be able to file returns. Absence of a matching period row
    // means the customer's process is run-driven, not period-driven; the
    // approved-runs check in `generate-statutory-return` already guarantees
    // the underlying data is frozen. Treat as advisory, not blocking.
    return OK;
  }
  const status = String(row.status ?? "");
  if (!["closed", "locked", "filed"].includes(status)) {
    return {
      ok: false,
      code: "PAYROLL_PERIOD_NOT_CLOSED",
      message: `Payroll period ${row.start_date} → ${row.end_date} is ${status}; it must be closed before filing artifacts can be produced.`,
      recovery: "Close the payroll period in Payroll → Periods, then regenerate.",
      details: { period_id: row.id, status },
    };
  }
  return OK;
}
