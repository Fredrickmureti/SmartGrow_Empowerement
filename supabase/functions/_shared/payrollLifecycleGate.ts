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
 * `fy` must be `approved`, `posted`, or `paid`. Draft/failed/reversed runs
 * mean the YTD rollup would silently misreport the certificate.
 */
export async function requireApprovedRunsForYear(
  admin: SupabaseAdmin,
  args: { organization_id: string; business_id: string; fy: number },
): Promise<GateResult> {
  const start = `${args.fy}-01-01`;
  const end = `${args.fy}-12-31`;
  const { data, error } = await admin
    .from("payroll_runs")
    .select("id, status, period_start, period_end")
    .eq("organization_id", args.organization_id)
    .eq("business_id", args.business_id)
    .gte("period_start", start)
    .lte("period_end", end)
    .not("status", "in", "(approved,posted,paid,closed)");
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
        `Fiscal year ${args.fy} still has payroll runs that are not approved. ` +
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
    .select("id, status, period_start, period_end")
    .eq("organization_id", args.organization_id)
    .eq("business_id", args.business_id)
    .lte("period_start", args.period_start)
    .gte("period_end", args.period_end)
    .order("period_end", { ascending: false })
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
    return {
      ok: false,
      code: "PAYROLL_PERIOD_MISSING",
      message: `No payroll period exists covering ${args.period_start} → ${args.period_end}.`,
      recovery: "Create the payroll period first (Payroll → Periods), then regenerate.",
      details: { period_start: args.period_start, period_end: args.period_end },
    };
  }
  const status = String(row.status ?? "");
  if (!["closed", "locked", "filed"].includes(status)) {
    return {
      ok: false,
      code: "PAYROLL_PERIOD_NOT_CLOSED",
      message: `Payroll period ${row.period_start} → ${row.period_end} is ${status}; it must be closed before filing artifacts can be produced.`,
      recovery: "Close the payroll period in Payroll → Periods, then regenerate.",
      details: { period_id: row.id, status },
    };
  }
  return OK;
}
