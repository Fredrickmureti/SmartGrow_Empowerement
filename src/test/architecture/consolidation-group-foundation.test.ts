/**
 * Consolidation — group and ownership foundation (Brick 1) ratchet.
 *
 * The database owns the invariants (see
 * `supabase/tests/consolidation_group_foundation_test.sql`). This guard pins
 * the *shape* of the client so the surface cannot quietly regress:
 *
 *  - the configuration screen is reachable from a real route, not an orphan;
 *  - membership is closed out through the server RPC, never hard-deleted;
 *  - company and currency pickers read the authoritative sources
 *    (`get_user_allowed_businesses`, enabled operating currencies) instead of
 *    hardcoded lists;
 *  - the screen produces no consolidated figures — Brick 1 is configuration
 *    only, so no ledger tables and no accounting arithmetic live here;
 *  - nothing points at the retired `/reports/consolidation` path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const SETTINGS = "src/components/settings/ConsolidationGroupsSettings.tsx";
const HOOK = "src/hooks/finance/useConsolidationGroups.ts";

describe("consolidation group configuration is reachable", () => {
  it("is rendered by the Finance settings page", () => {
    const src = read("src/pages/finance/FinanceSettings.tsx");
    expect(src).toMatch(/ConsolidationGroupsSettings/);
    expect(src).toMatch(/<ConsolidationGroupsSettings\s*\/>/);
  });
});

describe("membership is closed out, never erased", () => {
  it("the hook calls the close-out RPC and never deletes a membership row", () => {
    const src = read(HOOK);
    expect(src).toMatch(/close_consolidation_member/);
    expect(src).not.toMatch(/from\("consolidation_group_members"\)[\s\S]{0,200}?\.delete\(/);
  });

  it("the screen offers a close-out action rather than a delete action", () => {
    const src = read(SETTINGS);
    expect(src).toMatch(/closeMember|Close membership/);
    expect(src).not.toMatch(/deleteMember/);
  });
});

describe("pickers read the authoritative sources", () => {
  it("companies come from the allowed-businesses RPC", () => {
    expect(read(HOOK)).toMatch(/get_user_allowed_businesses/);
    expect(read(SETTINGS)).toMatch(/useConsolidationAllowedBusinessIds/);
  });

  it("the reporting currency is limited to the parent's enabled operating currencies", () => {
    const src = read(SETTINGS);
    expect(src).toMatch(/useBusinessCurrenciesFor/);
    // No literal currency menus: the operating-currency contract is the source.
    expect(src).not.toMatch(/\[\s*"USD"\s*,\s*"EUR"/);
  });

  it("write actions are gated on the same roles the RLS write policy allows", () => {
    expect(read(HOOK)).toMatch(/useCanManageConsolidation/);
    expect(read(SETTINGS)).toMatch(/useCanManageConsolidation/);
  });
});

describe("Brick 1 is configuration only", () => {
  it("the screen and hook contain no ledger reads and no accounting arithmetic", () => {
    for (const p of [SETTINGS, HOOK]) {
      const src = read(p);
      expect(src).not.toMatch(/journal_entry_lines|journal_entries/);
      expect(src).not.toMatch(/get_account_movements|get_ledger_opening_balances/);
      expect(src).not.toMatch(/exchange_rates/);
    }
  });

  it("the configuration history is exposed read-only", () => {
    const src = read(HOOK);
    expect(src).toMatch(/consolidation_group_change_log/);
    expect(src).not.toMatch(
      /from\("consolidation_group_change_log"\)[\s\S]{0,200}?\.(insert|update|delete)\(/,
    );
  });
});

describe("no stale consolidation route survives", () => {
  it("BusinessContext no longer advertises /reports/consolidation", () => {
    expect(read("src/contexts/BusinessContext.tsx")).not.toMatch(/\/reports\/consolidation/);
  });
});
