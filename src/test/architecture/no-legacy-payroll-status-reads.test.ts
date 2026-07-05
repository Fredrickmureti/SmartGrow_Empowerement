/**
 * Architecture guard (ADR-0058).
 *
 * Any read of `payroll_runs.status` for a value outside the calculation
 * lifecycle (`draft|calculating|calculated|approved|cancelled|reversed`)
 * is a regression: it re-couples a downstream workflow to the
 * calculation status column that ADR-0058 explicitly decouples.
 *
 * The allow-listed files are the last known internal readers that still
 * legitimately need the derived legacy label (e.g. audit logs, saga
 * projections). New code MUST NOT be added to the allow-list without a
 * paired update to ADR-0058.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const SCAN_DIRS = ["src", "supabase/functions"];
const FORBIDDEN = /status\s*[!=]==?\s*["'](posted|paid)["']/;
const ALLOW = new Set<string>([
  // Test files (they intentionally reference the deprecated literals).
  "src/test/architecture/no-legacy-payroll-status-reads.test.ts",
  "src/test/payroll/parallel-workflows-preconditions.test.ts",
  "src/test/payroll/tax-certificate-rpc-signature.test.ts",
  // Runtime lifecycle helper — canonical projection over the new
  // columns, intentionally references legacy literals for callers still
  // in transition.
  "src/lib/payroll/runLifecycle.ts",
  // Phase 6a migration ratchet: the 11 pre-existing readers below are
  // the last known coupling sites. New code MUST NOT be added to this
  // list without a matching ADR-0058 update. Each entry has an issue
  // to migrate the reader to the workflow-state columns / the
  // `payroll_runs_legacy_status_v` compatibility view.
  "src/components/employees/EmployeePayslipHistory.tsx",
  "src/components/finance/FinanceAccountingControls.tsx",
  "src/components/finance/TransactionPreviewDrawer.tsx",
  "src/components/payroll/PayrollRunDetailsDialog.tsx",
  "src/components/payroll/PayrollRunList.tsx",
  "src/hooks/usePayroll.ts",
  "src/pages/hr/HRDashboard.tsx",
  "src/pages/hr/payroll/Overview.tsx",
  "src/pages/hr/payroll/PayrollControlCenter.tsx",
  "src/pages/hr/payroll/sections.tsx",
  "supabase/functions/_shared/reports/payrollData.ts",
]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (e === "node_modules" || e === ".git" || e === "dist") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx|js|mjs)$/.test(e)) {
      yield p;
    }
  }
}

describe("ADR-0058 — no legacy payroll_runs.status coupling", () => {
  it("no source file compares payroll_runs.status against 'posted' or 'paid' outside the allow-list", () => {
    const violations: string[] = [];
    for (const base of SCAN_DIRS) {
      for (const abs of walk(resolve(ROOT, base))) {
        const rel = abs.substring(ROOT.length + 1).replace(/\\/g, "/");
        if (ALLOW.has(rel)) continue;
        const src = readFileSync(abs, "utf8");
        // Only flag when the comparison sits next to a payroll_runs context
        // (status column, run.status accessor, or payroll_runs table name).
        if (!FORBIDDEN.test(src)) continue;
        if (!/payroll_run|payroll_runs|\brun\.status\b/i.test(src)) continue;
        violations.push(rel);
      }
    }
    expect(violations, `Files still coupling to payroll_runs.status:\n${violations.join("\n")}`).toEqual([]);
  });
});
