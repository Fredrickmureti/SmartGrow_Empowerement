/**
 * Brick 2 invariants — consolidated trial balance.
 *
 * These guard the architectural rules that make the report trustworthy:
 * aggregation and authorization live in SQL, the client only regroups rows,
 * and no second accounting engine is introduced in JavaScript.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  groupTrialBalanceByAccount,
  nonControllingShare,
  describeConsolidationBlocker,
  type ConsolidatedTrialBalanceRow,
} from "@/hooks/finance/useConsolidatedTrialBalance";

const root = process.cwd();
const hookSource = readFileSync(
  join(root, "src/hooks/finance/useConsolidatedTrialBalance.ts"),
  "utf8",
);
const pageSource = readFileSync(
  join(root, "src/pages/reports/ConsolidatedTrialBalance.tsx"),
  "utf8",
);
const types = readFileSync(join(root, "src/integrations/supabase/types.ts"), "utf8");

function row(over: Partial<ConsolidatedTrialBalanceRow>): ConsolidatedTrialBalanceRow {
  return {
    business_id: "b1",
    business_name: "Alpha",
    is_parent: true,
    ownership_percent: 100,
    account_id: "a1",
    account_code: "1000",
    account_name: "Cash",
    account_type: "asset",
    is_nominal: false,
    opening_balance: 0,
    total_debit: 0,
    total_credit: 0,
    closing_balance: 0,
    ...over,
  };
}

describe("Brick 2 — server owns aggregation", () => {
  it("exposes the consolidation RPCs in the generated database types", () => {
    expect(types).toContain("get_consolidated_trial_balance");
    expect(types).toContain("resolve_consolidation_scope");
  });

  it("reads balances only through the consolidated RPC, never from ledger tables", () => {
    expect(hookSource).toContain('supabase.rpc("get_consolidated_trial_balance"');
    expect(hookSource).toContain('supabase.rpc("resolve_consolidation_scope"');
    for (const table of ["journal_entry_lines", "journal_entries", "from(\"accounts\")"]) {
      expect(hookSource).not.toContain(table);
      expect(pageSource).not.toContain(table);
    }
  });

  it("does not re-implement account classification in the client", () => {
    // Classification (income vs expense, nominal vs real) belongs to the SQL
    // reporting engine. A client-side account_type switch would be a second
    // source of accounting truth.
    expect(pageSource).not.toMatch(/account_type\s*===\s*"income"/);
    expect(hookSource).not.toMatch(/account_type\s*===\s*"(income|expense)"/);
  });
});

describe("Brick 2 — regrouping is arithmetic-free beyond addition of server rows", () => {
  it("combines member contributions per account and keeps them traceable", () => {
    const lines = groupTrialBalanceByAccount([
      row({ business_id: "b1", total_debit: 100, closing_balance: 100 }),
      row({
        business_id: "b2",
        business_name: "Beta",
        is_parent: false,
        total_debit: 40,
        closing_balance: 40,
      }),
      row({ account_id: "a2", account_code: "2000", account_name: "Payables", total_credit: 60, closing_balance: -60 }),
    ]);

    expect(lines.map((l) => l.account_code)).toEqual(["1000", "2000"]);
    const cash = lines[0]!;
    expect(cash.total_debit).toBe(140);
    expect(cash.closing_balance).toBe(140);
    expect(cash.contributions).toHaveLength(2);
    expect(cash.contributions.map((c) => c.business_name)).toEqual(["Alpha", "Beta"]);
  });

  it("keeps full-consolidation members at 100 % (control model), not at ownership %", () => {
    const lines = groupTrialBalanceByAccount([
      row({ ownership_percent: 60, total_debit: 100, closing_balance: 100 }),
    ]);
    expect(lines[0]!.closing_balance).toBe(100);
  });

  it("discloses the non-controlling share separately", () => {
    expect(nonControllingShare(row({ ownership_percent: 60, closing_balance: 100 }))).toBeCloseTo(40);
    expect(nonControllingShare(row({ ownership_percent: 100, closing_balance: 100 }))).toBe(0);
    expect(nonControllingShare(row({ ownership_percent: null, closing_balance: 100 }))).toBe(0);
  });

  it("explains every blocker the resolver can raise", () => {
    for (const blocker of [
      "equity_method_not_supported_yet",
      "currency_translation_required",
      "member_has_no_base_currency",
      "ownership_percent_missing",
    ]) {
      expect(describeConsolidationBlocker(blocker)).not.toBe(blocker);
    }
  });
});

describe("Brick 2 — honest limits are stated, not faked", () => {
  it("tells the reader intercompany balances are not yet eliminated", () => {
    expect(pageSource).toMatch(/not yet eliminated/i);
  });

  it("contains no FX translation or elimination placeholders", () => {
    expect(pageSource).not.toMatch(/exchange_rate|translat(e|ed)Amount|eliminationAmount/);
  });
});
