/**
 * Architecture guard — self-action catalogue ↔ governance_action_registry parity.
 *
 * `governance_action_registry` (database) is the source of truth for governed
 * action keys. `SELF_ACTION_CATALOGUE` is only a compile-time mirror used to
 * label and group them in the Self-Action Policy UI. The two drifted during the
 * ERP → microfinance rebuild, which made lending actions invisible in Settings.
 *
 * REGISTRY_KEYS below is a snapshot of the live registry (verified 2026-09-07).
 * When a migration adds or removes a row, update this list and the catalogue in
 * the same change.
 */
import { describe, it, expect } from "vitest";
import { SELF_ACTION_CATALOGUE } from "@/lib/governance/selfActionCatalogue";

const REGISTRY_KEYS = [
  // Finance
  "bank_account.sensitive_change",
  "journal.post",
  "payment.approve",
  // Lending
  "loan.approve",
  "loan.disburse",
  "loan.restructure",
  "loan.write_off",
  "repayment.reverse",
  "reversal.loan_repayment",
  // Platform
  "app_access.grant",
  // Spend
  "expense.approve",
  "expense.approve_self_benefit",
  "expense.submit",
  "expense.void",
  "reversal.expense",
];

describe("Self-action catalogue parity", () => {
  const keys = SELF_ACTION_CATALOGUE.map((e) => e.key);

  it("mirrors every registered governance action", () => {
    for (const key of REGISTRY_KEYS) {
      expect(keys).toContain(key);
    }
  });

  it("declares no action that is not registered", () => {
    for (const key of keys) {
      expect(REGISTRY_KEYS).toContain(key);
    }
  });

  it("carries no inherited ERP action vocabulary", () => {
    const banned = /payroll|timesheet|leave|inventory|warehouse|pos\.|purchase|sales\./i;
    for (const key of keys) {
      expect(key).not.toMatch(banned);
    }
  });

  it("has unique keys", () => {
    expect(new Set(keys).size).toBe(keys.length);
  });
});
