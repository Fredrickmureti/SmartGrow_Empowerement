/**
 * Kernel snapshot — pins the classification and section ordering that
 * `buildBalanceSheet` / `buildIncomeStatement` produce for a fixed chart of
 * accounts.
 *
 * The fixture deliberately includes the two code bands the accounting-kernel
 * consolidation changed:
 *   - equity codes at 3200+ (server previously said `>= 3200`, client said
 *     `3200..3999`),
 *   - the 8000-8999 other-income / other-expense band (missing server-side).
 * Any future kernel edit that moves an account between sections shows up here
 * as a diff instead of silently changing a statutory statement.
 */
import { describe, it, expect } from "vitest";
import {
  buildBalanceSheet,
  buildIncomeStatement,
} from "../../../supabase/functions/_shared/reportDataEngine.ts";

type Row = Record<string, unknown>;

const ACCOUNTS: Row[] = [
  { id: "a1", code: "1000", name: "Cash", account_type: "asset", detail_type: null, parent_id: null, opening_balance: 5000, is_active: true },
  { id: "a2", code: "1200", name: "Accounts Receivable", account_type: "asset", detail_type: null, parent_id: null, opening_balance: 2000, is_active: true },
  { id: "a3", code: "1600", name: "Equipment", account_type: "asset", detail_type: null, parent_id: null, opening_balance: 8000, is_active: true },
  { id: "l1", code: "2000", name: "Accounts Payable", account_type: "liability", detail_type: null, parent_id: null, opening_balance: 3000, is_active: true },
  { id: "l2", code: "2600", name: "Long Term Loan", account_type: "liability", detail_type: null, parent_id: null, opening_balance: 4000, is_active: true },
  { id: "e1", code: "3000", name: "Share Capital", account_type: "equity", detail_type: null, parent_id: null, opening_balance: 7000, is_active: true },
  // 3200+ band — the divergence the kernel consolidation resolved.
  { id: "e2", code: "3200", name: "Retained Earnings", account_type: "equity", detail_type: null, parent_id: null, opening_balance: 1500, is_active: true },
  { id: "e3", code: "3900", name: "Owner Drawings", account_type: "equity", detail_type: null, parent_id: null, opening_balance: -500, is_active: true },
  { id: "i1", code: "4000", name: "Sales Revenue", account_type: "income", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  // 8000-8999 other income / other expense band.
  { id: "i2", code: "8100", name: "Interest Income", account_type: "income", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "x1", code: "5000", name: "Cost of Goods Sold", account_type: "expense", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "x2", code: "6000", name: "Rent Expense", account_type: "expense", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "x3", code: "8500", name: "Interest Expense", account_type: "expense", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
];

/**
 * Minimal Supabase query-builder double. Accounts come from the fixture and
 * journal lines are synthesised per account so every P&L line carries a
 * non-zero period movement (the builders skip zero-movement rows, so an
 * empty ledger would hide exactly the leaf rows this snapshot must pin).
 *
 * The engine issues three queries: accounts (`.in` on account_type), the
 * period lines (`.gte` + `.lte`) and the prior lines (`.lt` only). The double
 * distinguishes period from prior by whether `.gte` was called.
 */
/**
 * A balanced period ledger (debits 20,700 = credits 20,700): sales of 20,000
 * (19,700 cash / 300 receivable), 250 interest income, and 12,400 of costs
 * settled 11,950 in cash and 450 on account. Because it balances, the
 * snapshot doubles as an accounting-equation check.
 */
const PERIOD_MOVEMENT: Record<string, number> = {
  a1: 8000, a2: 300, a3: 0,
  l1: 450, l2: 0,
  e1: 0, e2: 0, e3: 0,
  i1: 20000, i2: 250,
  x1: 9000, x2: 3000, x3: 400,
};

function fakeSupabase() {
  return {
    from(table: string) {
      let typeFilter: string[] | null = null;
      let isPeriod = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        gte: () => {
          isPeriod = true;
          return builder;
        },
        lte: () => builder,
        lt: () => builder,
        in: (_col: string, values: string[]) => {
          typeFilter = values;
          return builder;
        },
        order: () => builder,
        then: (resolve: (v: unknown) => unknown) => {
          if (table === "accounts") {
            const rows = typeFilter
              ? ACCOUNTS.filter((a) => typeFilter!.includes(a.account_type as string))
              : ACCOUNTS;
            return resolve({ data: rows, error: null });
          }
          // Prior-period ledger is empty: opening balances are the fixture's.
          if (!isPeriod) return resolve({ data: [], error: null });
          const lines = ACCOUNTS.flatMap((a) => {
            const amount = PERIOD_MOVEMENT[a.id as string] ?? 0;
            if (amount === 0) return [];
            const debitNormal = a.account_type === "asset" || a.account_type === "expense";
            return [{
              account_id: a.id,
              debit: debitNormal ? amount : 0,
              credit: debitNormal ? 0 : amount,
            }];
          });
          return resolve({ data: lines, error: null });
        },
      };
      return builder;
    },
  };
}

const shape = (result: { data: Record<string, unknown>[] }) =>
  result.data.map((r) => ({
    label: r.name as string,
    // Balance sheet rows carry `closing_balance`; P&L rows carry `balance`.
    amount: (r.balance ?? r.closing_balance) as number | undefined,
    header: r._isHeader === true,
    subtotal: r._isSubtotal === true,
    grand: r._isGrandTotal === true,
  }));

describe("statement snapshot: kernel classification + section ordering", () => {
  it("balance sheet places 3200+ equity accounts in the equity section", async () => {
    // deno-lint-ignore no-explicit-any
    const result = await buildBalanceSheet(fakeSupabase() as any, "org", "biz", "2026-01-01", "2026-12-31");
    expect(shape(result)).toMatchSnapshot();

    // The fixture ledger balances, so the statement must too.
    const total = (label: string) =>
      (result.data.find((r) => r.name === label)?.closing_balance as number) ?? NaN;
    expect(total("TOTAL ASSETS")).toBeCloseTo(
      total("TOTAL LIABILITIES") + total("TOTAL EQUITY"),
      6,
    );
  });

  it("income statement places the 8000-8999 band as other income/expense", async () => {
    // deno-lint-ignore no-explicit-any
    const result = await buildIncomeStatement(fakeSupabase() as any, "org", "biz", "2026-01-01", "2026-12-31");
    expect(shape(result)).toMatchSnapshot();
  });
});
