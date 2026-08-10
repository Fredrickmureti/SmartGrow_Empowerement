/**
 * Treasury instrument ids and GL account ids are DIFFERENT id spaces.
 *
 * `bill_payments.bank_account_id` FKs to `bank_accounts(id)` (a treasury
 * instrument). A journal line's `account_id` FKs to `accounts(id)` (a GL
 * account). `record_multi_bill_payment` historically used ONE parameter for
 * both, so a UI that selected a real bank account would have credited a
 * non-existent GL account. ADR 0129 split them: `_bank_account_id` is the
 * treasury id, `_credit_account_id` is the GL account credited by the JE.
 *
 * This ratchet pins the client side of that boundary.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = process.cwd();
const HOOK = readFileSync(join(PROJECT_ROOT, "src/hooks/useBills.ts"), "utf8");

describe("AP funding account split (ADR 0129)", () => {
  it("the bill payment hook sends an explicit GL credit account", () => {
    const call = HOOK.slice(HOOK.indexOf('rpc("record_multi_bill_payment'));
    expect(call).toMatch(/_credit_account_id\s*:/);
    expect(call).toMatch(/_payable_account_id\s*:/);
  });

  it("the GL credit account comes from default account mappings, not bank_accounts", () => {
    const call = HOOK.slice(
      HOOK.indexOf('rpc("record_multi_bill_payment'),
      HOOK.indexOf('rpc("record_multi_bill_payment') + 1400,
    );
    // The treasury id may only flow into _bank_account_id.
    expect(call).toMatch(/_credit_account_id:\s*cashAccountId/);
    expect(call).not.toMatch(/_credit_account_id:\s*args\.bank_account_id/);
  });

  it("no client passes a bank_accounts id into a GL account parameter", () => {
    const banned =
      /_(?:credit|payable|deposit|receivable|wht)_account_id\s*:\s*[A-Za-z0-9_.]*bank_account_id/;
    expect(banned.test(HOOK)).toBe(false);
  });
});
