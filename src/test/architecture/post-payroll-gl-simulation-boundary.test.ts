/**
 * ADR: Payroll Posting Simulation Boundary — architectural guards.
 *
 * The `post-payroll-gl` edge function serves BOTH the accountant preview
 * (`dry_run: true`) and the real posting event. A previous defect leaked
 * write-path controls (SoD, existing-JE short-circuit, closed-period
 * hard-fail) into the preview path — with the effect that clicking
 * "Simulate posting" on a run that already had a stray JE returned
 * `{ already_posted: true }` and made it look as if simulation had
 * posted the run. That, combined with the button living on the GL
 * Account Mapping configuration screen (never bound to a specific run),
 * produced the "simulate → posted, real post → already posted" symptom
 * reported in the enterprise-architecture audit.
 *
 * These tests lock the boundary so the regression cannot land silently:
 *
 *   1. The SoD helper is only invoked on the write path.
 *   2. The idempotency short-circuit is only taken on the write path;
 *      preview returns `already_posted` INSIDE the payload instead.
 *   3. Closed-period hard-fail is only raised on the write path;
 *      preview downgrades it to a warning.
 *   4. The write path enforces `status === 'approved'` explicitly (not
 *      merely via `user_can_post_payroll`), making "posted" reachable
 *      from exactly one prior state.
 *   5. The preview payload includes the new run-scoped fields
 *      (`already_posted`, `warnings`, `run_status`,
 *      `existing_journal_entry_id`).
 *   6. Every mutating call (`.insert`, `.update`, `.upsert`, `.delete`,
 *      `post_journal_entry_atomic`) appears AFTER the dry_run early
 *      return. `payroll_posting_previewed` is the single audit_logs row
 *      allowed in the preview branch (non-financial provenance).
 *   7. The GL Account Mapping page no longer mounts the old simulator
 *      — preview is a run-scoped action on the run, not a config action.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = readFileSync(
  join(process.cwd(), "supabase/functions/post-payroll-gl/index.ts"),
  "utf8",
);
const MAPPING = readFileSync(
  join(process.cwd(), "src/pages/hr/payroll/AccountMapping.tsx"),
  "utf8",
);
const RUN_DIALOG = readFileSync(
  join(process.cwd(), "src/components/payroll/PayrollRunDetailsDialog.tsx"),
  "utf8",
);

const dryRunReturnIdx = (() => {
  // Locate the closing `});` of the preview `return new Response(...)`.
  // We anchor on a field that only exists inside that return payload —
  // `run_status: payrollRun.status,` — to avoid matching the doc-comment
  // `dry_run: true` at the top of the file.
  const marker = "run_status: payrollRun.status";
  const i = EDGE.indexOf(marker);
  if (i < 0) throw new Error("preview return payload not found");
  const close = EDGE.indexOf("});", i);
  if (close < 0) throw new Error("preview return closing not found");
  return close;
})();

describe("post-payroll-gl — SoD gate is write-path only", () => {
  it("user_can_post_payroll is guarded by !dryRun", () => {
    const rpcIdx = EDGE.indexOf('"user_can_post_payroll"');
    expect(rpcIdx).toBeGreaterThan(0);
    // The preceding ~200 chars must contain `if (!dryRun)`.
    const context = EDGE.slice(Math.max(0, rpcIdx - 400), rpcIdx);
    expect(context).toMatch(/if\s*\(\s*!\s*dryRun\s*\)/);
  });
});

describe("post-payroll-gl — idempotency short-circuit is write-path only", () => {
  it("the existingJE early return is gated by !dryRun", () => {
    // Preview must never return `{ already_posted: true }` at the
    // idempotency check; that surface belongs to the write path.
    expect(EDGE).toMatch(
      /if\s*\(\s*existingJE\s*&&\s*!\s*dryRun\s*\)/,
    );
  });

  it("preview payload carries already_posted / existing_journal_entry_id", () => {
    const preview = EDGE.slice(0, dryRunReturnIdx);
    expect(preview).toMatch(/already_posted:\s*!!existingJE/);
    expect(preview).toMatch(/existing_journal_entry_id:\s*existingJE\?\.id/);
  });
});

describe("post-payroll-gl — closed-period is a warning on preview", () => {
  it("dry-run branch pushes period_closed into previewWarnings", () => {
    expect(EDGE).toMatch(/previewWarnings\.push\(\s*{\s*code:\s*"period_closed"/);
  });
  it("preview payload surfaces warnings[]", () => {
    const preview = EDGE.slice(0, dryRunReturnIdx);
    expect(preview).toMatch(/warnings:\s*previewWarnings/);
  });
});

describe("post-payroll-gl — write path requires status === 'approved'", () => {
  it("explicit state precondition exists after the dry_run early return", () => {
    const after = EDGE.slice(dryRunReturnIdx);
    expect(after).toMatch(/payrollRun\.status\s*!==\s*["']approved["']/);
    expect(after).toMatch(/"invalid_state"/);
    // The precondition must precede the atomic JE post.
    const stateIdx = after.indexOf('"invalid_state"');
    const postIdx = after.indexOf('"post_journal_entry_atomic"');
    expect(stateIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(stateIdx);
  });
});

describe("post-payroll-gl — dry_run branch performs no ledger writes", () => {
  it("preview slice contains no financial mutations", () => {
    const preview = EDGE.slice(0, dryRunReturnIdx);
    // Allowed: a single non-financial audit_logs insert tagged
    // 'payroll_posting_previewed'. Nothing else.
    expect(preview).not.toMatch(/post_journal_entry_atomic/);
    expect(preview).not.toMatch(/from\(["']payroll_runs["']\)\s*\.update/);
    expect(preview).not.toMatch(/from\(["']payroll_liabilities["']\)/);
    expect(preview).not.toMatch(/from\(["']payroll_liability_sources["']\)/);
  });

  it("audit_logs insert in preview is the read-only preview provenance row", () => {
    const preview = EDGE.slice(0, dryRunReturnIdx);
    // Find the audit_logs insert in the preview branch and verify its
    // action is exactly 'payroll_posting_previewed'.
    const auditIdx = preview.lastIndexOf('from("audit_logs")');
    expect(auditIdx).toBeGreaterThan(-1);
    const block = preview.slice(auditIdx, auditIdx + 800);
    expect(block).toMatch(/action:\s*["']payroll_posting_previewed["']/);
  });

  it("the ledger-writing audit_logs 'gl_posted' insert lives on the write path", () => {
    const after = EDGE.slice(dryRunReturnIdx);
    expect(after).toMatch(/action:\s*["']gl_posted["']/);
  });
});

describe("client — posting preview is run-scoped, not config-scoped", () => {
  it("GL Account Mapping page does NOT mount PayrollPostingSimulator", () => {
    expect(MAPPING).not.toMatch(/<PayrollPostingSimulator\b/);
  });

  it("GL Account Mapping page does NOT mount PayrollPostingPreviewDialog either (preview belongs on the run)", () => {
    expect(MAPPING).not.toMatch(/<PayrollPostingPreviewDialog\b/);
  });

  it("Payroll run details dialog mounts the run-scoped preview dialog", () => {
    expect(RUN_DIALOG).toMatch(/<PayrollPostingPreviewDialog\b/);
    expect(RUN_DIALOG).toMatch(/runId=\{run\.id\}/);
  });
});
