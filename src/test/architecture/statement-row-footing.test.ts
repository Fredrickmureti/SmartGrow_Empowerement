/**
 * Phase D ratchet — a financial statement must FOOT.
 *
 * Accounting principle: every section total must equal the sum of the rows the
 * reader can see, and every posting account must be presented exactly once.
 *
 * Two defects this pins:
 *
 * 1. Parent/child double counting. A parent account can itself be posted to.
 *    Totals must add each account's OWN amount once — never the parent's own
 *    amount plus a rolled-up subtree figure.
 * 2. Invisible-but-counted rows. `FinancialReports.tsx` used to drop every
 *    `is_group` account from the rendered rows while `useFinancialReport`
 *    still added those accounts to the section totals, so a chart with posted
 *    parents produced a statement whose rows did not add up to its totals —
 *    and whose PDF (a flat list of all accounts) showed rows the screen did
 *    not. The source guard below fails if that filter comes back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildIncomeStatement } from "../../../supabase/functions/_shared/reportDataEngine.ts";

type Row = Record<string, unknown>;

const FY_START = "2026-01-01";

/** Revenue parent (4000) with its own postings PLUS two children. */
const ACCOUNTS: Row[] = [
  { id: "i0", code: "4000", name: "Revenue", account_type: "income", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "i1", code: "4010", name: "Product Sales", account_type: "income", detail_type: null, parent_id: "i0", opening_balance: 0, is_active: true },
  { id: "i2", code: "4020", name: "Service Sales", account_type: "income", detail_type: null, parent_id: "i0", opening_balance: 0, is_active: true },
  { id: "x1", code: "5000", name: "Cost of Goods Sold", account_type: "expense", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
];

/** account_id → { debit, credit } for the requested window. */
const MOVEMENTS: Record<string, { debit: number; credit: number }> = {
  i0: { debit: 0, credit: 1000 }, // the parent's OWN postings
  i1: { debit: 0, credit: 6000 },
  i2: { debit: 0, credit: 3000 },
  x1: { debit: 4000, credit: 0 },
};

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
        order: () =>
          Promise.resolve({
            data: table === "accounts" ? ACCOUNTS : [],
            error: null,
          }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: table === "accounts" ? ACCOUNTS : [], error: null }),
      });
      return builder;
    },
    rpc(name: string) {
      if (name === "get_account_movements") {
        return Promise.resolve({
          data: Object.entries(MOVEMENTS).map(([account_id, m]) => ({
            account_id,
            total_debit: m.debit,
            total_credit: m.credit,
          })),
          error: null,
        });
      }
      if (name === "get_ledger_opening_balances") {
        return Promise.resolve({ data: [], error: null });
      }
      if (name === "get_equity_result") {
        return Promise.resolve({
          data: [{ fiscal_year_start: FY_START, current_year_earnings: 0, prior_years_result: 0, retained_earnings_account_id: null }],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    },
  };
}

describe("statement footing: parent accounts are counted once and shown once", () => {
  it("income statement revenue subtotal equals the sum of its rendered rows", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await buildIncomeStatement(makeSupabase() as any, "org", "biz", FY_START, "2026-12-31");
    const rows = result.data as Row[];

    const start = rows.findIndex((r) => r.name === "REVENUE");
    const end = rows.findIndex((r) => r.name === "Total Revenue");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const detail = rows.slice(start + 1, end);
    const codes = detail.map((r) => r.code);
    // The posted parent is a visible row, not a hidden contributor.
    expect(codes).toContain("4000");
    expect(codes).toContain("4010");
    expect(codes).toContain("4020");

    const sumOfRows = detail.reduce((s, r) => s + Number(r.balance ?? 0), 0);
    expect(sumOfRows).toBeCloseTo(Number(rows[end].balance), 2);
    // 1000 own + 6000 + 3000 — not 10000 + 9000 rolled up.
    expect(sumOfRows).toBeCloseTo(10000, 2);
    expect(Number(result.summary?.netIncome)).toBeCloseTo(6000, 2);
  });
});

describe("statement footing: the screen renders every account the totals count", () => {
  it("FinancialReports does not filter group accounts out of the rendered rows", () => {
    const src = readFileSync("src/pages/reports/FinancialReports.tsx", "utf8");
    expect(src).not.toMatch(/filter\(\s*a\s*=>\s*!a\.is_group\s*\)/);
  });
});
