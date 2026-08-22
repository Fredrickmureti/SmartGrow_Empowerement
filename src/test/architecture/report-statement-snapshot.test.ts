/**
 * Kernel snapshot + accounting invariants for the server-side statement
 * builders (`buildBalanceSheet` / `buildIncomeStatement`), which are what the
 * PDF/export path renders.
 *
 * Two things are pinned here:
 *
 * 1. Classification and section ordering for a fixed chart of accounts. The
 *    fixture includes the two code bands the accounting-kernel consolidation
 *    changed: equity at 3200+ and the 8000-8999 other-income / other-expense
 *    band. Any kernel edit that moves an account between sections shows up as a
 *    snapshot diff instead of silently changing a statutory statement.
 *
 * 2. The prior-years'-result invariant. `get_ledger_opening_balances` only
 *    folds closed years' result into the retained-earnings account when the
 *    requested date is at/before the fiscal-year start. A balance sheet built
 *    from a window that starts *inside* the current fiscal year therefore used
 *    to drop every prior year's profit out of equity — the statement did not
 *    balance. The double below reproduces that SQL semantic exactly, so the
 *    "balances regardless of the requested start date" assertions fail if the
 *    builder ever stops anchoring its window to the fiscal-year start.
 *
 * The double is RPC-shaped because the builders aggregate in SQL
 * (`get_account_movements`, `get_ledger_opening_balances`,
 * `get_equity_result`) rather than reading journal lines in the runtime.
 */
import { describe, it, expect } from "vitest";
import {
  buildBalanceSheet,
  buildIncomeStatement,
} from "../../../supabase/functions/_shared/reportDataEngine.ts";

type Row = Record<string, unknown>;

const FY_START = "2026-01-01";

const ACCOUNTS: Row[] = [
  { id: "a1", code: "1000", name: "Cash", account_type: "asset", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "a2", code: "1200", name: "Accounts Receivable", account_type: "asset", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "a3", code: "1600", name: "Equipment", account_type: "asset", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "l1", code: "2000", name: "Accounts Payable", account_type: "liability", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "l2", code: "2600", name: "Long Term Loan", account_type: "liability", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "e1", code: "3000", name: "Share Capital", account_type: "equity", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  // 3200+ band — the divergence the kernel consolidation resolved. This is the
  // retained-earnings account SQL folds closed years into.
  { id: "e2", code: "3200", name: "Retained Earnings", account_type: "equity", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "e3", code: "3900", name: "Owner Drawings", account_type: "equity", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "i1", code: "4000", name: "Sales Revenue", account_type: "income", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  // 8000-8999 other income / other expense band.
  { id: "i2", code: "8100", name: "Interest Income", account_type: "income", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "x1", code: "5000", name: "Cost of Goods Sold", account_type: "expense", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "x2", code: "6000", name: "Rent Expense", account_type: "expense", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
  { id: "x3", code: "8500", name: "Interest Expense", account_type: "expense", detail_type: null, parent_id: null, opening_balance: 0, is_active: true },
];

const ACCOUNT_TYPE = new Map(ACCOUNTS.map((a) => [a.id as string, a.account_type as string]));
const isDebitNormal = (id: string) =>
  ACCOUNT_TYPE.get(id) === "asset" || ACCOUNT_TYPE.get(id) === "expense";
const isNominal = (id: string) =>
  ACCOUNT_TYPE.get(id) === "income" || ACCOUNT_TYPE.get(id) === "expense";

type Line = { date: string; account_id: string; debit: number; credit: number };

/**
 * Every journal line, balanced by construction.
 *
 * Prior year (2025): capital 5,000 in cash, sales 4,000 on cash, costs 2,500 in
 * cash → closed-year result +1,500, cash 6,500, no explicit closing journal
 * (this ERP calculates retained earnings rather than posting closing entries).
 *
 * Current year (2026): sales 20,000 (19,700 cash / 300 receivable), interest
 * income 250 cash, equipment 8,000 bought on a 4,000 loan and 4,000 cash,
 * costs 12,400 (11,950 cash / 450 payable), drawings 500 cash.
 */
const LINES: Line[] = [
  // ── prior year ────────────────────────────────────────────────────────────
  { date: "2025-01-05", account_id: "a1", debit: 5000, credit: 0 },
  { date: "2025-01-05", account_id: "e1", debit: 0, credit: 5000 },
  { date: "2025-03-10", account_id: "a1", debit: 4000, credit: 0 },
  { date: "2025-03-10", account_id: "i1", debit: 0, credit: 4000 },
  { date: "2025-06-20", account_id: "x1", debit: 2500, credit: 0 },
  { date: "2025-06-20", account_id: "a1", debit: 0, credit: 2500 },
  // ── current year ──────────────────────────────────────────────────────────
  { date: "2026-02-01", account_id: "a1", debit: 19700, credit: 0 },
  { date: "2026-02-01", account_id: "a2", debit: 300, credit: 0 },
  { date: "2026-02-01", account_id: "i1", debit: 0, credit: 20000 },
  { date: "2026-02-15", account_id: "a1", debit: 250, credit: 0 },
  { date: "2026-02-15", account_id: "i2", debit: 0, credit: 250 },
  { date: "2026-03-01", account_id: "a3", debit: 8000, credit: 0 },
  { date: "2026-03-01", account_id: "l2", debit: 0, credit: 4000 },
  { date: "2026-03-01", account_id: "a1", debit: 0, credit: 4000 },
  { date: "2026-09-01", account_id: "x1", debit: 9000, credit: 0 },
  { date: "2026-09-01", account_id: "x2", debit: 3000, credit: 0 },
  { date: "2026-09-01", account_id: "x3", debit: 400, credit: 0 },
  { date: "2026-09-01", account_id: "l1", debit: 0, credit: 450 },
  { date: "2026-09-01", account_id: "a1", debit: 0, credit: 11950 },
  { date: "2026-11-01", account_id: "e3", debit: 500, credit: 0 },
  { date: "2026-11-01", account_id: "a1", debit: 0, credit: 500 },
];

const signed = (line: Line) =>
  isDebitNormal(line.account_id)
    ? line.debit - line.credit
    : line.credit - line.debit;

const nominalResult = (from: string | null, to: string) =>
  LINES.filter((l) => isNominal(l.account_id) && (from === null || l.date >= from) && l.date <= to)
    .reduce((sum, l) => sum + (ACCOUNT_TYPE.get(l.account_id) === "income" ? signed(l) : -signed(l)), 0);

/**
 * Supabase double reproducing the three reporting RPCs, including the SQL
 * fold rule: the closed years' result lands in the retained-earnings account
 * only when the requested date is at/before the fiscal-year start.
 */
function fakeSupabase(options: { retainedEarningsAccountId?: string | null } = {}) {
  const reAccountId =
    options.retainedEarningsAccountId === undefined ? "e2" : options.retainedEarningsAccountId;

  return {
    rpc(name: string, args: Record<string, unknown>) {
      let data: Row[] = [];

      if (name === "get_account_movements") {
        const from = args._date_from as string;
        const to = args._date_to as string;
        const byAccount = new Map<string, { debit: number; credit: number }>();
        for (const line of LINES) {
          if (line.date < from || line.date > to) continue;
          const acc = byAccount.get(line.account_id) ?? { debit: 0, credit: 0 };
          acc.debit += line.debit;
          acc.credit += line.credit;
          byAccount.set(line.account_id, acc);
        }
        data = [...byAccount].map(([account_id, v]) => ({
          account_id,
          total_debit: v.debit,
          total_credit: v.credit,
        }));
      } else if (name === "get_ledger_opening_balances") {
        const asOf = args._as_of as string;
        const foldsPriorYears = asOf <= FY_START;
        const byAccount = new Map<string, number>();
        for (const line of LINES) {
          if (line.date >= asOf) continue;
          // Nominal accounts restart at the fiscal-year boundary.
          if (isNominal(line.account_id) && foldsPriorYears) continue;
          byAccount.set(line.account_id, (byAccount.get(line.account_id) ?? 0) + signed(line));
        }
        if (foldsPriorYears && reAccountId) {
          const prior = nominalResult(null, asOf);
          byAccount.set(reAccountId, (byAccount.get(reAccountId) ?? 0) + prior);
        }
        data = [...byAccount].map(([account_id, opening_balance]) => ({
          account_id,
          opening_balance,
        }));
      } else if (name === "get_equity_result") {
        const asOf = args._as_of as string;
        data = [{
          fiscal_year_start: FY_START,
          current_year_earnings: nominalResult(FY_START, asOf),
          prior_years_result: nominalResult(null, FY_START),
          retained_earnings_account_id: reAccountId,
        }];
      } else {
        throw new Error(`unexpected rpc ${name}`);
      }

      return Promise.resolve({ data, error: null });
    },

    from(table: string) {
      let typeFilter: string[] | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        lte: () => builder,
        lt: () => builder,
        in: (_col: string, values: string[]) => {
          typeFilter = values;
          return builder;
        },
        order: () => builder,
        then: (resolve: (v: unknown) => unknown) => {
          if (table !== "accounts") return resolve({ data: [], error: null });
          const rows = typeFilter
            ? ACCOUNTS.filter((a) => typeFilter!.includes(a.account_type as string))
            : ACCOUNTS;
          return resolve({ data: rows, error: null });
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

const total = (result: { data: Record<string, unknown>[] }, label: string) =>
  (result.data.find((r) => r.name === label)?.closing_balance as number) ?? NaN;

// deno-lint-ignore no-explicit-any
const client = (o?: { retainedEarningsAccountId?: string | null }) => fakeSupabase(o) as any;

describe("statement snapshot: kernel classification + section ordering", () => {
  it("balance sheet places 3200+ equity accounts in the equity section", async () => {
    const result = await buildBalanceSheet(client(), "org", "biz", "2026-01-01", "2026-12-31");
    expect(shape(result)).toMatchSnapshot();

    // The fixture ledger balances, so the statement must too.
    expect(total(result, "TOTAL ASSETS")).toBeCloseTo(
      total(result, "TOTAL LIABILITIES") + total(result, "TOTAL EQUITY"),
      6,
    );
  });

  it("income statement places the 8000-8999 band as other income/expense", async () => {
    const result = await buildIncomeStatement(client(), "org", "biz", "2026-01-01", "2026-12-31");
    expect(shape(result)).toMatchSnapshot();
  });
});

describe("balance sheet: prior years' result never leaves equity", () => {
  const PRIOR_YEARS_RESULT = 1500;
  const CURRENT_YEAR_EARNINGS = 20000 + 250 - (9000 + 3000 + 400);

  it("balances and keeps closed-year profit whatever start date is requested", async () => {
    // "2026-07-01" is the regression case: a window opening inside the current
    // fiscal year, where SQL does not fold the closed years' result.
    for (const startStr of ["1970-01-01", "2026-01-01", "2026-07-01", "2026-12-01"]) {
      const result = await buildBalanceSheet(client(), "org", "biz", startStr, "2026-12-31");

      expect(total(result, "TOTAL ASSETS")).toBeCloseTo(
        total(result, "TOTAL LIABILITIES") + total(result, "TOTAL EQUITY"),
        6,
      );
      expect(result.summary.priorYearsResult).toBeCloseTo(PRIOR_YEARS_RESULT, 6);
      expect(result.summary.retainedEarnings).toBeCloseTo(CURRENT_YEAR_EARNINGS, 6);

      // The closed year's result is inside the retained-earnings ACCOUNT, and
      // must not also be added as a separate line — that would double it.
      const reRow = result.data.find((r) => r.code === "3200");
      expect(reRow?.closing_balance).toBeCloseTo(PRIOR_YEARS_RESULT, 6);
      expect(result.data.some((r) => String(r.name).startsWith("Prior years' result"))).toBe(false);
    }
  });

  it("presents the closed years' result separately when no retained-earnings account exists", async () => {
    const result = await buildBalanceSheet(
      client({ retainedEarningsAccountId: null }), "org", "biz", "2026-01-01", "2026-12-31",
    );

    const unallocated = result.data.find((r) => String(r.name).startsWith("Prior years' result"));
    expect(unallocated?.closing_balance).toBeCloseTo(PRIOR_YEARS_RESULT, 6);
    expect(result.summary.hasRetainedEarningsAccount).toBe(false);
    expect(total(result, "TOTAL ASSETS")).toBeCloseTo(
      total(result, "TOTAL LIABILITIES") + total(result, "TOTAL EQUITY"),
      6,
    );
  });
});
