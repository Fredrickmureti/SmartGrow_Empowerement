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
