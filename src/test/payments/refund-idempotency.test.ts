/**
 * ADR 0012 R4 — refund idempotency.
 *
 * `clientRequestId` MUST be derived deterministically from the
 * (payment, reasonCode, amountCents, bankAccountId) tuple so a
 * double-click cannot double-spend. The previous regression was
 * `crypto.randomUUID()` at mount time, which collided with retries
 * but not with re-mounts.
 *
 * Pre-refund unapply MUST use a derived key (`${requestId}-pre-unapply`)
 * so the two RPC calls are individually idempotent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WIZARD = readFileSync(
  join(process.cwd(), "src/components/payments/ReversePaymentWizard.tsx"),
  "utf8",
);

describe("ADR 0012 R4 — refund idempotency", () => {
  it("derives the request id from payment + reason + amount + bank", () => {
    expect(WIZARD).toMatch(/makeDeterministicRequestId/);
    expect(WIZARD).toMatch(
      /function makeDeterministicRequestId\([\s\S]{0,200}paymentId[\s\S]{0,200}reasonCode[\s\S]{0,200}amountCents[\s\S]{0,200}bankAccountId/,
    );
    expect(WIZARD).toMatch(
      /return\s+`rev-\$\{paymentId\}-\$\{reasonCode\}-\$\{amountCents\}-\$\{bankAccountId/,
    );
  });

  it("memoizes the request id on the actual intent tuple", () => {
    // The dependency array must include payment.id, reason, op, refundCents,
    // and bankAccountId so identical intents collide and distinct intents
    // get distinct keys.
    // Note: `payment?.id` (optional chain) is required — the memo runs
    // unconditionally on every render, including when `payment` is null
    // (see "no hooks below `if (!payment) return null`" rule in
    // payment-reversal-intent-contract.test.ts).
    expect(WIZARD).toMatch(
      /useMemo\([\s\S]{0,400}makeDeterministicRequestId[\s\S]{0,400}\[payment\?\.id,\s*selected\?\.code,\s*selected\?\.op,\s*refundCents,\s*bankAccountId\]/,
    );
  });

  it("never falls back to crypto.randomUUID for the request id", () => {
    expect(WIZARD).not.toMatch(/randomUUID\(\)/);
  });

  it("pre-refund unapply uses a derived sub-key", () => {
    expect(WIZARD).toMatch(/`\$\{requestId\}-pre-unapply`/);
  });
});
