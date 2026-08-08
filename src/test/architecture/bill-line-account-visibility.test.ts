/**
 * P2 guard (ADR 0122) — purchases-side UI parity.
 *
 * Bill lines carry an `account_id` override that decides which GL account the
 * line debits. Both bill editors must show the *effective* account and its
 * tier (`LineAccountCell`), the same way the product form does, instead of
 * leaving the posting rule invisible.
 *
 * Purchase orders are intentionally out of scope: `purchase_order_items` has
 * no account column and POs do not post to the ledger.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const EDITORS = [
  "src/features/purchases/bills/BillCreatePage.tsx",
  "src/features/purchases/bills/BillEditPage.tsx",
] as const;

describe("bill line GL account visibility", () => {
  for (const file of EDITORS) {
    const src = readFileSync(file, "utf8");

    it(`${file} renders the inheritance-aware account cell`, () => {
      expect(src).toContain("LineAccountCell");
      expect(src).toContain("vendorExpenseAccountId");
    });
  }

  it("the account cell resolves through the full ladder", () => {
    const src = readFileSync("src/components/documents/lines/LineAccountCell.tsx", "utf8");
    expect(src).toContain("resolveCategoryAccount");
    expect(src).toContain("purchase_account_id");
    expect(src).toContain("inventory_account_id");
    expect(src).toContain("operating_expenses_id");
    // Must never present an unnamed default.
    expect(src).not.toContain("Use system default");
  });
});
