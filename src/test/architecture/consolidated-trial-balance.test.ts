/**
 * Bricks 2 and 3 invariants — consolidated trial balance and its currency
 * translation.
 *
 * These guard the architectural rules that make the report trustworthy:
 * aggregation, translation and authorization live in SQL, the client only
 * regroups rows, no second accounting engine is introduced in JavaScript, and
 * no consolidation capability is left built-but-unreachable in the UI.
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
const settingsSource = readFileSync(
  join(root, "src/components/settings/ConsolidationGroupsSettings.tsx"),
  "utf8",
);
const groupsHookSource = readFileSync(
  join(root, "src/hooks/finance/useConsolidationGroups.ts"),
  "utf8",
);
const types = readFileSync(join(root, "src/integrations/supabase/types.ts"), "utf8");

const clientSources = [hookSource, pageSource, settingsSource, groupsHookSource].join("\n");

function row(over: Partial<ConsolidatedTrialBalanceRow>): ConsolidatedTrialBalanceRow {
  return {
    business_id: "b1",
    business_name: "Alpha",
    is_parent: true,
    ownership_percent: 100,
    base_currency: "USD",
    presentation_currency: "USD",
    account_id: "a1",
    account_code: "1000",
    account_name: "Cash",
    account_type: "asset",
    is_nominal: false,
    rate_class: "closing",
    rate_used: 1,
    opening_balance: 0,
    total_debit: 0,
    total_credit: 0,
    closing_balance: 0,
    translated_opening: 0,
    translated_debit: 0,
    translated_credit: 0,
    translated_closing: 0,
    ...over,
  };
}

describe("server owns aggregation and translation", () => {
  it("exposes the consolidation RPCs in the generated database types", () => {
    expect(types).toContain("get_consolidated_trial_balance_translated");
    expect(types).toContain("consolidation_cta_reconciliation");
    expect(types).toContain("resolve_consolidation_scope");
  });

  it("reads balances only through the consolidated RPCs, never from ledger tables", () => {
    expect(hookSource).toContain('"get_consolidated_trial_balance_translated"');
    expect(hookSource).toContain('supabase.rpc("resolve_consolidation_scope"');
    expect(hookSource).toContain('supabase.rpc("consolidation_cta_reconciliation"');
    for (const table of ["journal_entry_lines", "journal_entries"]) {
      expect(hookSource).not.toContain(table);
      expect(pageSource).not.toContain(table);
    }
  });

  it("never falls back to the untranslated aggregation RPC", () => {
    // Two aggregation paths would be two answers to the same question. The
    // translated RPC is a superset: same-currency members translate at 1.
    expect(clientSources).not.toMatch(/rpc\(\s*"get_consolidated_trial_balance"/);
  });

  it("does not re-implement account classification or FX rates in the client", () => {
    expect(pageSource).not.toMatch(/account_type\s*===\s*"income"/);
    expect(hookSource).not.toMatch(/account_type\s*===\s*"(income|expense)"/);
    // Rates come back on the server's rows; the client never multiplies by one.
    expect(hookSource).not.toMatch(/\*\s*rate/);
    expect(pageSource).not.toMatch(/\*\s*(rate_used|rate)\b/);
  });
});

describe("no consolidation capability is left unreachable", () => {
  it("surfaces every user-facing consolidation RPC somewhere in the UI", () => {
    // A capability that exists only in the database is a capability the user
    // does not have. Internal helpers (translate_member, member_translation_rates,
    // scope_member_count, fy_start) are deliberately excluded: they are called
    // by other SQL, never by a browser.
    for (const rpc of [
      "get_consolidated_trial_balance_translated",
      "resolve_consolidation_scope",
      "consolidation_cta_reconciliation",
      "close_consolidation_member",
    ]) {
      expect(clientSources).toContain(rpc);
    }
  });

  it("lets the user configure the translation reserve account and equity rate date", () => {
    expect(groupsHookSource).toContain("cta_account_id");
    expect(settingsSource).toContain("cta_account_id");
    expect(settingsSource).toContain("historical_rate_date");
  });
});

describe("regrouping is arithmetic-free beyond addition of server rows", () => {
  it("combines member contributions per account in the presentation currency", () => {
    const lines = groupTrialBalanceByAccount([
      row({ business_id: "b1", translated_debit: 100, translated_closing: 100 }),
      row({
        business_id: "b2",
        business_name: "Beta",
        is_parent: false,
        base_currency: "KES",
        presentation_currency: "USD",
        rate_used: 0.4,
        total_debit: 100,
        translated_debit: 40,
        translated_closing: 40,
      }),
      row({
        account_id: "a2",
        account_code: "2000",
        account_name: "Payables",
        translated_credit: 60,
        translated_closing: -60,
      }),
    ]);

    expect(lines.map((l) => l.account_code)).toEqual(["1000", "2000"]);
    const cash = lines[0]!;
    expect(cash.total_debit).toBe(140);
    expect(cash.closing_balance).toBe(140);
    expect(cash.contributions).toHaveLength(2);
    expect(cash.contributions.map((c) => c.business_name)).toEqual(["Alpha", "Beta"]);
  });

  it("marks the translation reserve line the engine emits as a balancing figure", () => {
    const lines = groupTrialBalanceByAccount([
      row({ account_id: "cta", account_code: "3900", rate_class: "residual", rate_used: null }),
    ]);
    expect(lines[0]!.is_residual).toBe(true);
  });

  it("keeps full-consolidation members at 100 % (control model), not at ownership %", () => {
    const lines = groupTrialBalanceByAccount([
      row({ ownership_percent: 60, translated_debit: 100, translated_closing: 100 }),
    ]);
    expect(lines[0]!.closing_balance).toBe(100);
  });

  it("discloses the non-controlling share of translated figures separately", () => {
    expect(nonControllingShare(row({ ownership_percent: 60, translated_closing: 100 }))).toBeCloseTo(40);
    expect(nonControllingShare(row({ ownership_percent: 100, translated_closing: 100 }))).toBe(0);
    expect(nonControllingShare(row({ ownership_percent: null, translated_closing: 100 }))).toBe(0);
  });

  it("explains every blocker the resolver can raise", () => {
    for (const blocker of [
      "equity_method_not_supported_yet",
      "member_has_no_base_currency",
      "ownership_percent_missing",
      "cta_account_not_configured",
    ]) {
      expect(describeConsolidationBlocker(blocker)).not.toBe(blocker);
    }
  });
});

describe("honest limits are stated, not faked", () => {
  it("tells the reader intercompany balances are not yet eliminated", () => {
    expect(pageSource).toMatch(/not yet eliminated/i);
  });

  it("no longer claims currency translation is unavailable", () => {
    expect(pageSource).not.toMatch(/translation and eliminations arrive in later phases/i);
    expect(hookSource).not.toMatch(/FX translation is Brick 3/i);
  });
});
