/**
 * Phase E ratchet — deactivating an account must not delete money.
 *
 * Deactivation is chart-of-accounts hygiene, not settlement. A closed bank
 * account or a retired loan account still carries a position the entity owns
 * or owes until it is actually cleared. Both the screen hook and the server
 * engine used to fetch accounts with `is_active = true`, so the row vanished
 * from the statement while the equity/result RPCs still counted its movement:
 * the balance sheet stopped balancing the day someone tidied the chart.
 *
 * The presentation rule is unchanged — an inactive account with no opening
 * balance and no movement is suppressed like any other empty account — so the
 * chart still reads clean.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildBalanceSheet } from "../../../supabase/functions/_shared/reportDataEngine.ts";

type Row = Record<string, unknown>;

const FY_START = "2026-01-01";

const ACCOUNTS: Row[] = [
  { id: "a1", code: "1000", name: "Cash", account_type: "asset", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  // Closed bank account that still holds 2,500 — deactivated, not settled.
  { id: "a2", code: "1010", name: "Closed Bank Account", account_type: "asset", detail_type: null, parent_id: null, opening_balance: 0, is_active: false },
  // Deactivated AND empty — must stay off the statement.
  { id: "a3", code: "1020", name: "Retired Petty Cash", account_type: "asset", detail_type: null, parent_id: null, opening_balance: 0, is_active: false },
  { id: "e1", code: "3000", name: "Share Capital", account_type: "equity", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "e2", code: "3200", name: "Retained Earnings", account_type: "equity", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
];

/** Opening position at the fiscal-year start: capital 10,000 split across two banks. */
const OPENINGS: Record<string, number> = { a1: 7500, a2: 2500, e1: 10000, e2: 0 };

function makeSupabase() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        in: chain,
        gte: chain,
        lte: chain,
        order: chain,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: table === "accounts" ? ACCOUNTS : [], error: null }),
      });
      return builder;
    },
    rpc(name: string) {
      if (name === "get_account_movements") {
        return Promise.resolve({ data: [], error: null });
      }
      if (name === "get_ledger_opening_balances") {
        return Promise.resolve({
          data: Object.entries(OPENINGS).map(([account_id, opening_balance]) => ({
            account_id,
            opening_balance,
          })),
          error: null,
        });
      }
      if (name === "get_equity_result") {
        return Promise.resolve({
          data: [{
            fiscal_year_start: FY_START,
            current_year_earnings: 0,
            prior_years_result: 0,
            retained_earnings_account_id: "e2",
          }],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    },
  };
}

describe("balance sheet: a deactivated account keeps its balance", () => {
  it("presents the closed account and still balances", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await buildBalanceSheet(makeSupabase() as any, "org", "biz", FY_START, "2026-12-31");
    const rows = result.data as Row[];
    const names = rows.map((r) => r.name);

    expect(names).toContain("Closed Bank Account");
    // Deactivated and empty stays suppressed — hygiene still works.
    expect(names).not.toContain("Retired Petty Cash");

    const total = (label: string) =>
      Number(rows.find((r) => r.name === label)?.closing_balance ?? 0);

    const totalAssets = total("TOTAL ASSETS");
    const totalLiabEquity = total("TOTAL LIABILITIES") + total("TOTAL EQUITY");
    expect(totalAssets).toBeCloseTo(10000, 2);
    expect(totalAssets).toBeCloseTo(totalLiabEquity, 2);
  });

});

describe("source guard: reporting never filters accounts by is_active", () => {
  it("neither the hook nor the engine restricts the chart to active accounts", () => {
    const hook = readFileSync("src/hooks/useFinancialReport.ts", "utf8");
    const engine = readFileSync("supabase/functions/_shared/reportDataEngine.ts", "utf8");
    // `businesses` may still be filtered by is_active; the account queries may not.
    const accountFilter = /from\("accounts"\)[\s\S]{0,400}?\.eq\("is_active",\s*true\)/;
    expect(hook).not.toMatch(accountFilter);
    expect(engine).not.toMatch(accountFilter);
  });
});
