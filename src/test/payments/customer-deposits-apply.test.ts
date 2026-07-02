/**
 * ADR 0012 R3 — Customer Deposits application contract.
 *
 * Pins the invariants of `ApplyCustomerDepositDialog`:
 *   1. Amount is hard-clamped to min(deposit.outstanding, invoice.balance).
 *   2. `clientRequestId` is deterministic on (paymentId, invoiceId, cents)
 *      so a double-click cannot double-spend.
 *   3. On success the dialog invalidates every affected read model.
 *   4. The dialog ONLY routes through `applyCustomerDeposit` — never
 *      writes directly to AR or invokes any banned reversal primitive.
 *   5. The read hook filters to outstanding > 0 and excludes voided.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIALOG = readFileSync(
  join(process.cwd(), "src/components/payments/ApplyCustomerDepositDialog.tsx"),
  "utf8",
);
const HOOK = readFileSync(
  join(process.cwd(), "src/hooks/useCustomerUnappliedDeposits.ts"),
  "utf8",
);

describe("ADR 0012 R3 — apply customer deposit dialog", () => {
  it("hard-clamps amount to min(deposit outstanding, invoice balance)", () => {
    expect(DIALOG).toMatch(
      /Math\.min\(selectedDeposit\.outstanding_amount,\s*selectedInvoice\.balance\)/,
    );
  });

  it("derives a deterministic clientRequestId", () => {
    expect(DIALOG).toMatch(
      /`apply-\$\{selectedDeposit\.id\}-\$\{selectedInvoice\.id\}-\$\{cents\}`/,
    );
  });

  it("calls applyCustomerDeposit and never the banned reversal primitives", () => {
    expect(DIALOG).toMatch(/applyCustomerDeposit\(/);
    expect(DIALOG).not.toMatch(/\.voidPayment\(/);
    expect(DIALOG).not.toMatch(/\.unapplyPayment\(/);
    expect(DIALOG).not.toMatch(/\.refundCustomer\(/);
  });

  it("invalidates every affected read model on success", () => {
    for (const key of [
      "customer-unapplied-deposits",
      "customer-outstanding-balance",
      "invoices",
      "invoice",
      "payments",
      "open-invoices-for-deposit",
    ]) {
      expect(DIALOG, `must invalidate ${key}`).toMatch(
        new RegExp(`invalidateQueries\\(\\{\\s*queryKey:\\s*\\[\\s*["']${key}["']`),
      );
    }
  });

  it("renders the GL preview (DR AR / CR Customer Deposits)", () => {
    expect(DIALOG).toMatch(/DR Accounts Receivable/);
    expect(DIALOG).toMatch(/CR Customer Deposits/);
  });
});

describe("ADR 0012 R3 — useCustomerUnappliedDeposits read model", () => {
  it("filters to outstanding > 0 and excludes voided", () => {
    expect(HOOK).toMatch(/\.gt\(["']outstanding_amount["'],\s*0\)/);
    expect(HOOK).toMatch(/\.neq\(["']status["'],\s*["']voided["']\)/);
  });

  it("scopes to organization + business", () => {
    expect(HOOK).toMatch(/\.eq\(["']organization_id["']/);
    expect(HOOK).toMatch(/\.eq\(["']business_id["']/);
  });
});
