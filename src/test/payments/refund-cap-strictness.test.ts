/**
 * ADR 0012 R4 — refund cap is strict.
 *
 * The wizard MUST default the refund cap to `outstandingAmount` only.
 * Raising the cap requires the operator to tick the
 * "Also free cash from the linked invoice" checkbox; the silent
 * pre-refund unapply branch MUST throw if the checkbox is not ticked.
 *
 * Source-grep contract test in the project's standard pattern
 * (see src/test/architecture/payment-reversal-intent-contract.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WIZARD = readFileSync(
  join(process.cwd(), "src/components/payments/ReversePaymentWizard.tsx"),
  "utf8",
);

describe("ADR 0012 R4 — refund cap strictness", () => {
  it("defines the explicit unapply acknowledgement state", () => {
    expect(WIZARD).toMatch(/allowUnapplyForRefund/);
    expect(WIZARD).toMatch(/setAllowUnapplyForRefund\(false\)/);
  });

  it("default refund cap is the unapplied portion, not the gross amount", () => {
    // Cap calc must branch on allowUnapplyForRefund and exclude
    // appliedAmount unless the checkbox is ticked.
    expect(WIZARD).toMatch(
      /allowUnapplyForRefund[\s\S]{0,160}outstandingAmount\s*\+\s*appliedAmount[\s\S]{0,160}outstandingAmount/,
    );
  });

  it("silent pre-refund unapply is banned", () => {
    // The throw is the regression guard: without the checkbox, the
    // wizard refuses to call unapplyPayment behind the operator's back.
    expect(WIZARD).toMatch(
      /if \(!allowUnapplyForRefund\)[\s\S]{0,200}throw new Error/,
    );
  });

  it("refund > cap is rejected with an explicit error", () => {
    expect(WIZARD).toMatch(/amt > refundCap[\s\S]{0,200}throw new Error/);
  });

  it("pre-refund unapply uses the dedicated reason code", () => {
    expect(WIZARD).toMatch(/reasonCode:\s*["']pre_refund_unapply["']/);
  });
});
