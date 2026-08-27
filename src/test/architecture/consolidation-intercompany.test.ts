/**
 * Brick 6 invariants — intercompany identification.
 *
 * Identification must be a declaration, never a guess, and the paired balances
 * must come from the server engine. These tests guard the application half:
 *
 * - the declaration table and the balances engine are reachable from the UI;
 * - the client never infers intercompany status from names, codes or
 *   descriptions, and never nets, sums or translates positions itself;
 * - a disagreement between two members is disclosed, and the page states
 *   plainly that no elimination entries are produced.
 *
 * The database half — the declaration guard (self-counterparty, foreign
 * contact, overlapping periods), audit logging and the reciprocal pairing
 * arithmetic — is proven by
 * supabase/tests/consolidation_intercompany_test.sql.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReconciled } from "@/hooks/finance/useConsolidationIntercompany";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const hook = read("src/hooks/finance/useConsolidationIntercompany.ts");
const page = read("src/pages/reports/ConsolidationIntercompany.tsx");
const types = read("src/integrations/supabase/types.ts");
const financeRoutes = read("src/apps/finance/routes.tsx");
const reportRegistry = read("src/services/reports/ReportRegistry.ts");
const reportsNav = read("src/services/reports/reportsNav.ts");

describe("intercompany declarations are wired to the database", () => {
  it("uses the declaration table and the server balances engine", () => {
    expect(hook).toContain("consolidation_intercompany_partners");
    expect(hook).toContain("consolidation_intercompany_balances");
  });

  it("both symbols exist in the generated database types", () => {
    expect(types).toContain("consolidation_intercompany_partners");
    expect(types).toContain("consolidation_intercompany_balances");
  });

  it("ends a declaration with a date instead of rewriting history", () => {
    expect(hook).toContain("effective_to");
  });
});

describe("the client owns no intercompany accounting", () => {
  it("never reads ledger tables directly", () => {
    for (const source of [hook, page]) {
      expect(source).not.toContain("journal_entry_lines");
      expect(source).not.toContain("customer_ledger_entries");
      expect(source).not.toContain("vendor_ledger_entries");
    }
  });

  it("never resolves exchange rates or accumulates positions in the browser", () => {
    for (const source of [hook, page]) {
      expect(source).not.toContain("exchange_rates");
      expect(source).not.toContain("resolve_exchange_rate");
    }
    // The difference is the server's figure, not a browser subtraction.
    expect(page).not.toMatch(/declaring_amount\s*-\s*counterparty_amount/);
  });

  it("does not infer intercompany status from names or codes", () => {
    for (const source of [hook, page]) {
      expect(source).not.toMatch(/intercompany.*\.(ilike|like)\(/i);
      expect(source).not.toMatch(/name.*includes\(\s*["']inter/i);
    }
  });
});

describe("findings are disclosed, not absorbed", () => {
  it("treats only an exact match as reconciled", () => {
    const base = { difference: 0 } as Parameters<typeof isReconciled>[0];
    expect(isReconciled(base)).toBe(true);
    expect(isReconciled({ ...base, difference: 0.01 })).toBe(false);
    expect(isReconciled({ ...base, difference: -2000 })).toBe(false);
  });

  it("states that no elimination entries are produced", () => {
    expect(page).toContain("No elimination entries are produced");
  });

  it("surfaces a refusal from the engine instead of showing zeros", () => {
    expect(page).toContain("balancesQuery.error");
  });
});

describe("the report is reachable", () => {
  it("has a route, a registry entry and a place in the reports navigation", () => {
    expect(financeRoutes).toContain("reports/intercompany");
    expect(reportRegistry).toContain("intercompany-identification");
    expect(reportsNav).toContain("intercompany-identification");
  });
});

/**
 * Brick 6, second half — the group-account projection and the coverage
 * worklist.
 *
 * Two RPCs were added on top of the declaration layer:
 *
 * - `consolidation_intercompany_activity` projects intercompany ledger
 *   activity onto the *translated* consolidated trial balance, so the group
 *   account and the rate come from the same engine the statements use. There
 *   must never be a second place that decides what an intercompany figure is.
 * - `consolidation_intercompany_coverage` lists activity against a member's
 *   contact that carries no declaration for the period — the blind spot a
 *   declaration-only model has by construction.
 *
 * Both refuse rather than under-report. These tests hold that shape in place.
 */
describe("the group-account projection is wired to the one engine", () => {
  it("reaches the activity RPC through the hook", () => {
    expect(hook).toContain("consolidation_intercompany_activity");
    expect(hook).toContain("useConsolidationIntercompanyActivity");
  });

  it("reaches the coverage RPC through the hook", () => {
    expect(hook).toContain("consolidation_intercompany_coverage");
    expect(hook).toContain("useConsolidationIntercompanyCoverage");
  });

  it("both RPCs exist in the generated database types", () => {
    expect(types).toContain("consolidation_intercompany_activity");
    expect(types).toContain("consolidation_intercompany_coverage");
  });

  it("the page consumes both hooks rather than re-deriving either", () => {
    expect(page).toContain("useConsolidationIntercompanyActivity");
    expect(page).toContain("useConsolidationIntercompanyCoverage");
  });

  it("keeps the group-account dimension on the activity table", () => {
    // The projection is only trustworthy if the reader can see which group
    // account the figure lands on; without it the number cannot be tied back
    // to the statement line it belongs to.
    expect(page).toContain("group_account_code");
    expect(page).toContain("group_account_name");
    expect(page).toContain("Group account");
  });

  it("shows the rate the engine used, never one the browser picked", () => {
    expect(hook).toContain("rate_used");
    expect(hook).toContain("rate_class");
    for (const source of [hook, page]) {
      expect(source).not.toContain("resolve_exchange_rate");
      expect(source).not.toContain("exchange_rates");
    }
  });
});

describe("the client owns no part of the projection", () => {
  it("never reads the ledger or the trial balance directly for these views", () => {
    for (const source of [hook, page]) {
      expect(source).not.toContain("journal_entry_lines");
      expect(source).not.toContain("get_consolidated_trial_balance");
      expect(source).not.toContain("consolidation_account_mappings");
      expect(source).not.toContain("consolidation_group_accounts");
    }
  });

  it("never resolves an account mapping in the browser", () => {
    // is_mapped and the group account are the server's verdict. A client-side
    // fallback would silently invent a mapping the statements do not have.
    expect(page).not.toMatch(/is_mapped\s*(\?\?|\|\|)\s*true/);
    expect(page).not.toMatch(/group_account_code\s*(\?\?|\|\|)\s*[a-z]*account_code/i);
  });

  it("never sums or nets activity across members in the browser", () => {
    expect(page).not.toMatch(/\.reduce\([^)]*net_base/);
    expect(page).not.toMatch(/\.reduce\([^)]*\bnet\b\s*[,)]/);
    expect(page).not.toMatch(/debit\s*-\s*credit/);
  });

  it("suggests a counterparty only on the server's stated basis", () => {
    // The RPC suggests on exact legal-identifier identity and says which in
    // suggestion_basis. A name-similarity guess in the client would turn an
    // auditable identification into an inference.
    expect(hook).toContain("suggestion_basis");
    expect(page).not.toMatch(/name.*\.(includes|startsWith|match)\(/i);
  });
});

describe("refusals stay visible on both new surfaces", () => {
  it("renders the activity engine's message instead of an empty table", () => {
    expect(page).toContain("activityQuery.error");
    expect(page).toMatch(/activityQuery\.error[\s\S]{0,400}?\.message/);
  });

  it("renders the coverage engine's message instead of an empty table", () => {
    expect(page).toContain("coverageQuery.error");
    expect(page).toMatch(/coverageQuery\.error[\s\S]{0,400}?\.message/);
  });

  it("distinguishes a refusal from a genuinely empty period", () => {
    // An error branch and an empty branch must both exist, and the error
    // branch must be tested first — otherwise a refused run reads as "nothing
    // to report", which is the exact failure this brick refuses to allow.
    for (const q of ["activity", "coverage"]) {
      const errorAt = page.indexOf(`${q}Query.error ?`);
      const emptyAt = page.indexOf(`${q}Rows.length === 0`);
      expect(errorAt).toBeGreaterThan(-1);
      expect(emptyAt).toBeGreaterThan(-1);
      expect(errorAt).toBeLessThan(emptyAt);
    }
  });

  it("still produces no elimination entries", () => {
    expect(page).toContain("No elimination entries are produced");
    expect(hook).not.toMatch(/elimination/i);
  });
});
