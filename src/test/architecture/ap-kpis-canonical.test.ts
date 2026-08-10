/**
 * Ratchet — AP money figures come from the canonical projection.
 *
 * `get_ap_summary` / `finance_ap_open_items` is the only place AP money is
 * computed: it reflects vendor credit notes, advances, multi-currency and
 * excludes pre-posting states (draft / submitted / approved). Re-deriving
 * outstanding or overdue money by reducing over the `bills` rows loaded in
 * the page silently disagrees with the ledger.
 *
 * Document *counts* over the filtered list are fine — they describe the list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const BILLS_PAGE = join(process.cwd(), "src", "pages", "Bills.tsx");
const AP_SUMMARY = join(process.cwd(), "src", "hooks", "useApSummary.ts");

describe("AP KPIs — canonical source", () => {
  const src = readFileSync(BILLS_PAGE, "utf8");

  it("the Bills page reads the canonical AP summary", () => {
    expect(src).toContain("useApSummary");
  });

  it("outstanding and overdue money come from the summary, not a reduce", () => {
    expect(src).toContain("outstanding: apSummary.totalOutstanding");
    expect(src).toContain("overdue: apSummary.totalOverdue");
  });

  it("the summary hook is backed by get_ap_summary", () => {
    const hook = readFileSync(AP_SUMMARY, "utf8");
    expect(hook).toContain("get_ap_summary");
  });
});
