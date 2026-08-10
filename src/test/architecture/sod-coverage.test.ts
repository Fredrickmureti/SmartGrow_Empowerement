/**
 * Architecture guard — SoD Wave G2.
 *
 * Snapshots the contract that every entity whose approval lifecycle is
 * server-enforced by the Self-Action Framework has a corresponding
 * `sod_*_guard` trigger registered in the latest migration. If a new
 * approval surface is added to the Self-Action Catalogue without a
 * matching DB trigger, this test fails so the gap can never silently
 * land in code review.
 *
 * The test does NOT introspect the live database — it pins the static
 * coverage map to the catalogue + the migration file that ships the
 * triggers, so it works in CI without DB access.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SELF_ACTION_CATALOGUE } from "@/lib/governance/selfActionCatalogue";

// Map: catalogue action key → the table whose status-transition trigger
// enforces it. Keys that share a trigger with another action (e.g. the
// "_self_benefit" variants of loan/contract/compensation/expense) are
// listed against the same table.
const ACTION_TO_TABLE: Record<string, string> = {
  "payroll.approve": "payroll_runs",
  "payroll_payment_batch.approve": "payroll_payment_batches",
  "payroll_payment_batch.lock": "payroll_payment_batches",
  "payroll_payment_batch.transmit": "payroll_payment_batches",
  "payroll_payment_batch.pay": "payroll_payment_batches",
  "payroll_payment_batch.cancel": "payroll_payment_batches",
  "payroll_payment_batch.reverse": "payroll_payment_batches",
  "leave.approve": "leave_requests",
  "leave.approve_l2": "leave_requests",
  "timesheet.approve": "timesheet_submissions",
  "loan.approve": "employee_loans",
  "loan.approve_self_benefit": "employee_loans",
  "employee_loan.authorize_disbursement": "employee_loans",
  "employee_loan.write_off": "employee_loans",
  "employee_loan.restructure": "employee_loans",
  "employee_loan.refinance": "employee_loans",
  "employee_loan.record_manual_repayment": "employee_loans",
  "payroll.loan_skip_override.approve": "payroll_run_loan_skip_overrides",
  "payroll.loan_skip_override.reject": "payroll_run_loan_skip_overrides",
  "payroll.loan_skip_override.cancel": "payroll_run_loan_skip_overrides",


  "compensation.approve": "employee_compensation_history",
  "compensation.approve_self_benefit": "employee_compensation_history",
  "contract.approve": "employee_contracts",
  "contract.approve_self_benefit": "employee_contracts",
  "bill.approve": "bills",
  "bill_payment.approve": "bill_payments",
  "payment.approve": "payments",
  "journal.post": "journal_entries",
  "customer_refund.approve": "customer_refunds",
  "purchase_order.approve": "purchase_orders",
  "vendor_credit_note.approve": "vendor_credit_notes",
  "credit_note.approve": "credit_notes",
  "inventory.approve_adjustment": "stock_adjustments",
  "inventory.approve_transfer": "stock_transfers",
  "expense.approve": "expenses",
  "expense.approve_self_benefit": "expenses",
  "scrap.approve": "stock_adjustments",
  "scrap.post": "stock_adjustments",
  "scrap.reverse": "stock_adjustments",
  "bank_account.sensitive_change": "bank_accounts",

};

/**
 * Actions enforced inside a SECURITY DEFINER RPC rather than by a row trigger.
 * The physical-count lifecycle only transitions through
 * physical_count_submit / _approve / _post, so the self-action check lives in
 * those functions instead of a table guard.
 */
const RPC_ENFORCED_ACTIONS: Record<string, string> = {
  "requisition.approve": "approve_requisition",
  "rfq.approve": "rfq_approve",
  "rfq.award": "rfq_award",
  "inventory.submit_count": "physical_count_submit",
  "inventory.approve_count": "physical_count_approve",
  "inventory.post_count": "physical_count_post",
};


function readMigrations(): string {
  const dir = join(process.cwd(), "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

describe("SoD self-action coverage", () => {
  it("every catalogue action maps to a known table or enforcing RPC", () => {
    for (const entry of SELF_ACTION_CATALOGUE) {
      expect(
        ACTION_TO_TABLE[entry.key] ?? RPC_ENFORCED_ACTIONS[entry.key],
        `missing table mapping for ${entry.key}`,
      ).toBeTruthy();
    }
  });

  it("RPC-enforced actions assert the self-action guard", () => {
    const sql = readMigrations();
    for (const [key, fn] of Object.entries(RPC_ENFORCED_ACTIONS)) {
      const re = new RegExp(`governance_assert_not_self[\\s\\S]{0,400}?${key.replace(".", "\\.")}`, "i");
      expect(re.test(sql), `${fn} must call governance_assert_not_self for ${key}`).toBe(true);
    }
  });


  it("every guarded table has a sod_*_guard trigger in migrations", () => {
    const sql = readMigrations();
    const tables = new Set(Object.values(ACTION_TO_TABLE));
    // payroll_runs uses the legacy trg_enforce_payroll_maker_checker name.
    tables.delete("payroll_runs");
    // employee_compensation_history's trigger drops the "employee_" prefix
    // (sod_compensation_history_guard) — assert that variant directly.
    tables.delete("employee_compensation_history");
    expect(
      /CREATE TRIGGER sod_compensation_history_guard\b/i.test(sql),
      "missing CREATE TRIGGER sod_compensation_history_guard in migrations",
    ).toBe(true);
    for (const table of tables) {
      const re = new RegExp(`CREATE TRIGGER sod_${table}_guard\\b`, "i");
      expect(re.test(sql), `missing CREATE TRIGGER sod_${table}_guard in migrations`).toBe(true);
    }
    expect(/CREATE TRIGGER trg_enforce_payroll_maker_checker/.test(sql)).toBe(true);
  });

  it("governance_assert_not_self helper is defined", () => {
    const sql = readMigrations();
    expect(/CREATE OR REPLACE FUNCTION public\.governance_assert_not_self/.test(sql)).toBe(true);
    expect(/CREATE OR REPLACE FUNCTION public\.governance_assert_not_subject/.test(sql)).toBe(true);
  });

  it("self_action_overrides is append-only via immutable trigger", () => {
    const sql = readMigrations();
    expect(/trg_self_action_overrides_immutable/.test(sql)).toBe(true);
  });
});
