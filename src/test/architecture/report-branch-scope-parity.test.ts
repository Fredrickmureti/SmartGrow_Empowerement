/**
 * Branch scope is ONE rule.
 *
 * The screens hide the branch selector for entity-level statements (balance
 * sheet, trial balance, cash flow, tax, consolidation, FX revaluation) and
 * force `branchId = null`. The server dispatchers must reach the same answer,
 * or a scheduled/rendered Trial Balance can be branch-sliced — a statement
 * that by construction does not balance — under the same title the screen
 * uses for the entity-level one.
 *
 * These assertions pin the shared gate that both sides now call.
 */
import { describe, it, expect } from "vitest";
import {
  BRANCH_SCOPABLE,
  isBranchScopable,
  scopeBranchForReport,
  toReportKind,
} from "@/lib/reports/branchScopability";

const BRANCH = "11111111-1111-1111-1111-111111111111";

describe("branch scopability registry", () => {
  it("keeps entity-level statements entity-level", () => {
    for (const kind of ["balance_sheet", "trial_balance", "cash_flow", "tax", "consolidation", "fx_revaluation"] as const) {
      expect(BRANCH_SCOPABLE[kind]).toBe(false);
      expect(isBranchScopable(kind)).toBe(false);
    }
  });

  it("keeps flow/dimensional reports sliceable", () => {
    for (const kind of ["pnl", "general_ledger", "journal", "ar_aging", "ap_aging", "sales"] as const) {
      expect(isBranchScopable(kind)).toBe(true);
    }
  });
});

describe("scopeBranchForReport — the gate both dispatchers call", () => {
  it("strips the branch from entity-level statements", () => {
    expect(scopeBranchForReport("balance_sheet", BRANCH)).toBeUndefined();
    expect(scopeBranchForReport("trial_balance", BRANCH)).toBeUndefined();
    expect(scopeBranchForReport("cash_flow", BRANCH)).toBeUndefined();
  });

  it("passes the branch through for sliceable reports", () => {
    expect(scopeBranchForReport("income_statement", BRANCH)).toBe(BRANCH);
    expect(scopeBranchForReport("profit_and_loss", BRANCH)).toBe(BRANCH);
    expect(scopeBranchForReport("general_ledger", BRANCH)).toBe(BRANCH);
    expect(scopeBranchForReport("ar_aging", BRANCH)).toBe(BRANCH);
  });

  it("defaults an unregistered report type to entity-only", () => {
    expect(scopeBranchForReport("some_new_report", BRANCH)).toBeUndefined();
    expect(toReportKind("some_new_report")).toBeNull();
  });

  it("is a no-op when no branch was requested", () => {
    expect(scopeBranchForReport("general_ledger", null)).toBeUndefined();
    expect(scopeBranchForReport("general_ledger", undefined)).toBeUndefined();
  });
});
