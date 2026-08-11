import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Expense GL posting guards.
 *
 * Root cause of the "expense_submit → 400" incident: the payment-account
 * picker offered header (group) accounts such as `1010 Cash and Cash
 * Equivalents`. `prevent_journal_post_to_header` then rejected the journal
 * line deep inside `post_journal_entry_atomic`, rolling the whole submission
 * back and leaving the expense in `draft`.
 *
 * These are source-level ratchets: they fail the build if either half of the
 * fix is removed.
 */
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("expense posting guards", () => {
  it("never offers header (group) accounts as an expense payment account", () => {
    const src = read("src/features/purchases/expenses/usePaymentAccounts.ts");
    expect(src).toMatch(/\.eq\(\s*"is_header"\s*,\s*false\s*\)/);
  });

  it("preserves the Postgres error envelope on expense command failures", () => {
    const src = read("src/lib/finance/expenseCommands.ts");
    // The RPC wrapper must not collapse a Postgres error into a bare Error:
    // `normalizeError` needs `code` to surface business-rule (P0001) messages.
    expect(src).toMatch(/code:\s*error\.code/);
    expect(src).toMatch(/hint:\s*error\.hint/);
  });
});
