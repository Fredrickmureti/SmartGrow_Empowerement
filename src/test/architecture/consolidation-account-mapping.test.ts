/**
 * Brick 4 invariants — group chart of accounts and account mapping.
 *
 * Member companies keep their own charts of accounts, so a group figure is only
 * defensible when an explicit, auditable mapping row says which member account
 * belongs to which group line. These tests guard the application half of that
 * rule: the mapping tables and the unmapped worklist are actually reachable
 * from the UI, the client never invents a mapping of its own (for example by
 * matching account codes), and a line nobody mapped is disclosed rather than
 * quietly merged.
 *
 * The database half — refusal on unmapped posted balances, cross-type and
 * overlapping-period rejection, translation-reserve protection, change logging
 * and tenant isolation — is proven by
 * supabase/tests/consolidation_account_mapping_test.sql.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  groupTrialBalanceByAccount,
  type ConsolidatedTrialBalanceRow,
} from "@/hooks/finance/useConsolidatedTrialBalance";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const mappingHook = read("src/hooks/finance/useConsolidationAccountMapping.ts");
const mappingUi = read("src/components/settings/ConsolidationAccountMapping.tsx");
const groupSettings = read("src/components/settings/ConsolidationGroupsSettings.tsx");
const trialBalanceHook = read("src/hooks/finance/useConsolidatedTrialBalance.ts");
const trialBalancePage = read("src/pages/reports/ConsolidatedTrialBalance.tsx");
const types = read("src/integrations/supabase/types.ts");

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
    group_account_id: null,
    group_account_code: null,
    group_account_name: null,
    is_mapped: false,
    ...over,
  };
}

describe("the group chart and its mappings are reachable", () => {
  it("exposes the mapping tables and worklist RPC in the generated database types", () => {
    expect(types).toContain("consolidation_group_accounts");
    expect(types).toContain("consolidation_account_mappings");
    expect(types).toContain("consolidation_unmapped_accounts");
  });

  it("reads and writes the group chart and the mappings from the client", () => {
    expect(mappingHook).toContain('.from("consolidation_group_accounts")');
    expect(mappingHook).toContain('.from("consolidation_account_mappings")');
    expect(mappingHook).toContain('supabase.rpc("consolidation_unmapped_accounts"');
  });

  it("mounts the mapping screen inside consolidation group settings", () => {
    expect(groupSettings).toContain("ConsolidationAccountMapping");
    expect(mappingUi).toContain("useConsolidationUnmappedAccounts");
  });
});

describe("the client never invents a mapping", () => {
  it("does not merge member accounts by matching account codes", () => {
    // Two members may legitimately reuse the same code for different things,
    // so code equality must never stand in for a mapping row.
    expect(trialBalanceHook).not.toMatch(/account_code\s*===\s*\w+\.account_code/);
    expect(trialBalancePage).not.toMatch(/account_code\s*===\s*\w+\.account_code/);
  });

  it("does not read the mapping tables directly from the reporting path", () => {
    // The translated RPC resolves the mapping server-side and refuses on gaps;
    // a second client-side resolution would be a second answer.
    expect(trialBalanceHook).not.toContain('.from("consolidation_account_mappings")');
    expect(trialBalancePage).not.toContain('.from("consolidation_account_mappings")');
  });
});

describe("regrouping honours the server's mapping decision", () => {
  it("merges two differently coded member accounts into one group line", () => {
    const lines = groupTrialBalanceByAccount([
      row({
        business_id: "b1",
        account_id: "a1",
        account_code: "4000",
        account_type: "income",
        group_account_id: "g-rev",
        group_account_code: "G-4000",
        group_account_name: "Group revenue",
        is_mapped: true,
        translated_credit: 60000,
        translated_closing: -60000,
      }),
      row({
        business_id: "b2",
        business_name: "Beta",
        is_parent: false,
        account_id: "a2",
        account_code: "RV-01",
        account_type: "income",
        group_account_id: "g-rev",
        group_account_code: "G-4000",
        group_account_name: "Group revenue",
        is_mapped: true,
        translated_credit: 15000,
        translated_closing: -15000,
      }),
    ]);

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.account_code).toBe("G-4000");
    expect(line.account_name).toBe("Group revenue");
    expect(line.total_credit).toBe(75000);
    expect(line.is_mapped).toBe(true);
    // Drill-down to the originating members survives the merge.
    expect(line.contributions.map((c) => c.business_name).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("keeps an unmapped line under its own member account instead of merging it", () => {
    const lines = groupTrialBalanceByAccount([
      row({ business_id: "b1", account_id: "a1", account_code: "1000", translated_debit: 100 }),
      row({
        business_id: "b2",
        business_name: "Beta",
        is_parent: false,
        account_id: "a2",
        account_code: "1000",
        translated_debit: 50,
      }),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.is_mapped === false)).toBe(true);
  });

  it("does not treat a mapped flag without a group account as mapped", () => {
    const lines = groupTrialBalanceByAccount([row({ is_mapped: true, group_account_id: null })]);
    expect(lines[0]!.is_mapped).toBe(false);
    expect(lines[0]!.account_code).toBe("1000");
  });
});

describe("mapping gaps are disclosed, not hidden", () => {
  it("tells the reader how many lines are still unmapped", () => {
    expect(trialBalancePage).toContain("unmappedLineCount");
  });
});
