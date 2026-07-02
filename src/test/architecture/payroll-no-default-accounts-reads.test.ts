/**
 * Architecture guard — Wave 5 (Finance consolidation)
 *
 * Payroll-module code MUST NOT:
 *   - read the legacy `default_accounts` table directly, OR
 *   - call the legacy `resolve_default_account` RPC, OR
 *   - import `src/lib/finance/resolveDefaultAccount.ts`.
 *
 * All "missing payroll account mappings" reads must go through:
 *   - `payroll_required_gl_mappings_for_run(p_run_id)` (per-run), or
 *   - `payroll_gl_readiness(_org_id,_business_id)` (org-wide).
 *
 * Posting-time resolution belongs to the `post-payroll-gl` edge function,
 * not to the React/hook surface.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const PAYROLL_DIRS = [
  "src/components/payroll",
  "src/hooks/payroll",
  "src/pages/hr/payroll",
  "src/hooks/usePayrollGL.ts",
];

const FORBIDDEN = [
  // direct table reads
  /\bfrom\s*\(\s*["']default_accounts["']\s*\)/i,
  // legacy RPC name
  /["']resolve_default_account["']/,
  // legacy helper import
  /from\s+["']@\/lib\/finance\/resolveDefaultAccount["']/,
];

function grepHits(): string[] {
  const cmd = `rg -n --no-heading --no-messages "default_accounts|resolve_default_account|resolveDefaultAccount" ${PAYROLL_DIRS.join(" ")} || true`;
  const out = execSync(cmd, { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

describe("payroll modules do not read the legacy default-accounts surface", () => {
  it("no payroll module references default_accounts / resolve_default_account / resolveDefaultAccount", () => {
    const lines = grepHits();
    const offenders = lines.filter((line) => FORBIDDEN.some((re) => re.test(line)));
    expect(offenders, `Payroll modules must route through payroll_required_gl_mappings_for_run or payroll_gl_readiness, not the legacy default-accounts surface. Offenders:\n${offenders.join("\n")}`).toEqual([]);
  });
});
