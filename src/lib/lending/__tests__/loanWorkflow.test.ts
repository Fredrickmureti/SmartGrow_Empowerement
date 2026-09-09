/**
 * Workflow matrix for the application → loan → disbursement chain.
 *
 * Two things are asserted here:
 *  1. the guidance the UI shows matches the chronological business-event chain
 *     the database enforces (no step is claimed complete before its event);
 *  2. a refusal raised by a lending guard keeps its business sentence instead
 *     of collapsing into `[object Object]` or leaking SQL detail.
 */
import { describe, expect, it } from "vitest";

import {
  decisionBlockedReason,
  describeApplicationWorkflow,
} from "@/lib/lending/applicationWorkflow";
import { lendingErrorMessage } from "@/lib/lending/lendingError";

const done = (status: Parameters<typeof describeApplicationWorkflow>[0], assessed: boolean) =>
  describeApplicationWorkflow(status, assessed, null)
    .steps.filter((s) => s.done)
    .map((s) => s.label);

describe("application workflow guidance", () => {
  it("walks the happy path one event at a time", () => {
    expect(done("draft", false)).toEqual(["Application captured"]);
    expect(done("submitted", false)).toEqual(["Application captured", "Submitted"]);
    expect(done("under_review", true)).toEqual([
      "Application captured",
      "Submitted",
      "Business visit assessed",
    ]);
    expect(done("approved", true)).toContain("Approved");
    expect(done("approved", true)).not.toContain("Loan created");
    expect(done("ready_for_disbursement", true)).toContain("Loan created");
    expect(done("disbursed", true)).toContain("Disbursed");
  });

  it("names loan creation — not a status flip — as the step after approval", () => {
    const { nextStep } = describeApplicationWorkflow("approved", true, null);
    expect(nextStep).toMatch(/create the loan/i);
  });

  it("points at the minted loan once it exists", () => {
    const { nextStep } = describeApplicationWorkflow("ready_for_disbursement", true, "LN-0007");
    expect(nextStep).toMatch(/disburse LN-0007/i);
  });

  it("does not claim disbursement before it happened", () => {
    expect(done("ready_for_disbursement", true)).not.toContain("Disbursed");
  });

  it("ends the chain on terminal states", () => {
    expect(describeApplicationWorkflow("rejected", true, null).nextStep).toBeNull();
    expect(describeApplicationWorkflow("cancelled", false, null).nextStep).toBeNull();
    expect(describeApplicationWorkflow("disbursed", true, "LN-1").nextStep).toBeNull();
  });
});

describe("premature actions are explained, not merely refused", () => {
  it("blocks a decision before the assessment", () => {
    expect(decisionBlockedReason("under_review", false)).toMatch(/assessment/i);
  });

  it("allows a decision once the assessment exists", () => {
    expect(decisionBlockedReason("under_review", true)).toBeNull();
  });

  it("blocks a decision outside review", () => {
    expect(decisionBlockedReason("approved", true)).toMatch(/under review/i);
    expect(decisionBlockedReason("draft", true)).toMatch(/under review/i);
  });
});

describe("lending refusals reach the user as business sentences", () => {
  it("keeps a guard's own wording from a Postgrest-shaped plain object", () => {
    const refusal = {
      code: "P0001",
      message: "Loan cannot be disbursed before the loan has been created.",
      details: null,
      hint: null,
    };
    const shown = lendingErrorMessage(refusal, "Could not disburse");
    expect(shown).toBe("Loan cannot be disbursed before the loan has been created.");
    expect(shown).not.toContain("[object Object]");
  });

  it("never renders [object Object] for any plain-object refusal", () => {
    const shapes: unknown[] = [
      { code: "P0001", message: "An application cannot be decided before an assessment." },
      { code: "23505", message: 'duplicate key value violates unique constraint "mf_loans_uniq"' },
      { code: "42501", message: "new row violates row-level security policy" },
      { message: "Some plain message" },
      {},
    ];
    for (const shape of shapes) {
      const shown = lendingErrorMessage(shape, "That action was refused");
      expect(shown).not.toMatch(/\[object Object\]/);
      expect(shown.length).toBeGreaterThan(0);
    }
  });

  it("does not leak SQL, constraint or policy detail", () => {
    const shown = lendingErrorMessage(
      { code: "23505", message: 'duplicate key value violates unique constraint "mf_loans_uniq"' },
      "Refused",
    );
    expect(shown).not.toMatch(/constraint|mf_loans_uniq/i);
  });

  it("turns a permission refusal into a permission sentence", () => {
    const shown = lendingErrorMessage(
      { code: "42501", message: "new row violates row-level security policy for table mf_loans" },
      "Refused",
    );
    expect(shown).toMatch(/permission/i);
    expect(shown).not.toMatch(/row-level security|mf_loans/i);
  });

  it("falls back only when nothing meaningful exists", () => {
    expect(lendingErrorMessage({}, "That action was refused")).toBe("That action was refused");
  });
});
