/**
 * Architecture guard for ADR-0045 (Payroll Batches as the Control Record).
 *
 * Pins the UI ↔ RPC contract by checking the hook still wires every
 * lifecycle action through Supabase RPC calls (not raw table updates).
 * If a future refactor swaps an RPC for a direct `from(...).update(...)`
 * the lifecycle trigger is bypassed and audit events stop firing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HOOK_PATH = resolve(__dirname, "../../hooks/payroll/usePayrollRunGroups.ts");
const RPC_NAMES = [
  "payroll_batch_create",
  "payroll_batch_submit",
  "payroll_batch_approve",
  "payroll_batch_cancel",
  "payroll_batch_mark_posted",
  "payroll_batch_mark_paid",
  "payroll_batch_close",
  "payroll_batch_reverse",
  "payroll_batch_add_run",
  "payroll_payment_batch_link",
] as const;

describe("payroll batch hook ↔ RPC contract (ADR-0045)", () => {
  const src = readFileSync(HOOK_PATH, "utf8");

  for (const rpc of RPC_NAMES) {
    it(`invokes ${rpc} via supabase.rpc()`, () => {
      const pattern = new RegExp(`supabase\\.rpc\\(\\s*['"]${rpc}['"]`);
      expect(pattern.test(src)).toBe(true);
    });
  }

  it("never updates payroll_run_groups.status directly", () => {
    // The lifecycle trigger is the single source of truth for status
    // transitions; the client must go through RPCs.
    expect(/from\(["']payroll_run_groups["']\)[\s\S]{0,200}\.update\(/.test(src)).toBe(false);
  });
});