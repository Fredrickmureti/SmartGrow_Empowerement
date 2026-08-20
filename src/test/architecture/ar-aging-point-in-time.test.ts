/**
 * Ratchet — receivables are read through the point-in-time AR engine.
 *
 * Phase 2 gave AR the twin of the payables engine
 * (`finance_ar_open_items_as_of` + `finance_ar_customer_credit_as_of`). The
 * legacy `finance_ar_open_items` / `finance_ar_customer_credit` views always
 * answer "today", so any surface that still reads them cannot reproduce a
 * closed period: a statement for March re-renders differently in April.
 *
 * This guards the canonical access layer (`services/finance/openItems.ts`),
 * which is where every AR consumer is funnelled.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(process.cwd(), "src");
const OPEN_ITEMS = readFileSync(join(ROOT, "services/finance/openItems.ts"), "utf8");

describe("Receivables — point-in-time engine", () => {
  it("exposes the AR engine as the canonical read", () => {
    expect(OPEN_ITEMS).toContain("finance_ar_open_items_as_of");
    expect(OPEN_ITEMS).toContain("fetchArOpenItemsAsOf");
  });

  it("never reads the always-today AR views directly", () => {
    expect(OPEN_ITEMS).not.toMatch(/\.from\(\s*['"`]finance_ar_open_items['"`]/);
    expect(OPEN_ITEMS).not.toMatch(/\.from\(\s*['"`]finance_ar_customer_credit['"`]/);
    expect(OPEN_ITEMS).not.toMatch(/\.from\(\s*['"`]customer_credit_balances['"`]/);
  });

  it("unapplied customer credit is as-of dated, like its vendor twin", () => {
    expect(OPEN_ITEMS).toContain("finance_ar_customer_credit_as_of");
    // The AR credit read must accept a reporting date, otherwise a statement
    // for a closed period nets credit that did not exist yet.
    expect(OPEN_ITEMS).toMatch(
      /export async function fetchUnappliedCustomerCredit\([^)]*asOf\?: string,?\s*\)/s,
    );
  });

  it("contact aging passes the reporting date to both sides", () => {
    expect(OPEN_ITEMS).toMatch(/fetchArOpenItemsAsOf\(\s*params\.orgId[^)]*asOf/s);
    expect(OPEN_ITEMS).toMatch(/fetchUnappliedCustomerCredit\(\s*params\.orgId[^)]*asOf/s);
  });

  it("cross-document AR sums use the base-currency residual", () => {
    // Mixed-currency exposures may only be added after conversion.
    expect(OPEN_ITEMS).toContain("base_residual_amount");
  });
});
