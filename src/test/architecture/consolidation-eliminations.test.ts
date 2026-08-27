import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Brick 7 guard: intercompany eliminations are produced by the database and
 * only ever *read* by the client.
 *
 * The failure this prevents is the classic one: a page that "helpfully"
 * nets two intercompany balances in TypeScript, so the statement stops
 * agreeing with the elimination set behind it, and neither figure can be
 * traced. Elimination arithmetic, the tolerance test, and the residual
 * posting all belong to `consolidation_generate_eliminations`.
 */

const ROOT = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const HOOK = "hooks/finance/useConsolidationEliminations.ts";
const PAGE = "pages/reports/ConsolidationEliminations.tsx";
const SETTINGS = "components/settings/ConsolidationEliminationRules.tsx";
const STATEMENTS = "pages/reports/ConsolidatedStatements.tsx";

/** Lines that combine two figures — the shape of a client-side re-derivation. */
function arithmeticOffenders(src: string): string[] {
  return src
    .split("\n")
    // Strip string and template literals first: a query key such as
    // "consolidation-elimination-rules" is a name, not a subtraction.
    .map((line) => line.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""'))
    .filter((line) =>
      /(debit|credit|amount|balance|difference|tolerance|aggregated|elimination|consolidated)[a-z_]*\s*[-+*/]\s*[A-Za-z(]/i.test(
        line,
      ),
    )
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"));
}

describe("consolidation eliminations — engine ownership", () => {
  it("the hook layer reads and commands, and never computes an elimination", () => {
    const src = read(HOOK);
    expect(arithmeticOffenders(src)).toEqual([]);
    // Generation is an RPC, never an insert built in the browser.
    expect(src).toContain("consolidation_generate_eliminations");
    expect(src).not.toMatch(/from\("consolidation_eliminations"\)\s*\.\s*(insert|update|delete)/);
  });

  it("the only client writes are policy rows, not elimination rows", () => {
    const src = read(HOOK);
    expect(src).toContain('from("consolidation_elimination_rules")');
    const writes = src.match(/\.(insert|upsert|update|delete)\(/g) ?? [];
    expect(writes.length).toBe(1);
  });

  it("the report page computes nothing and renders the server's refusal verbatim", () => {
    const src = read(PAGE);
    expect(arithmeticOffenders(src)).toEqual([]);
    expect(src).toContain("e instanceof Error ? e.message");
  });

  it("the policy screen holds decisions only — no elimination figures", () => {
    const src = read(SETTINGS);
    expect(arithmeticOffenders(src)).toEqual([]);
    expect(src).toContain("saveRule");
  });

  it("consolidated statements take all three columns from the server", () => {
    const src = read(STATEMENTS);
    expect(src).toContain("useEliminatedStatementLines");
    expect(src).toContain("aggregated_amount");
    expect(src).toContain("elimination_amount");
    expect(src).toContain("consolidated_amount");
    // No column is derived from another one.
    expect(src).not.toMatch(/aggregated_amount\s*[-+]\s*/);
    expect(src).not.toMatch(/consolidated_amount\s*[-+]\s*/);
  });

  it("no other page reads the elimination table directly", () => {
    for (const rel of [
      "pages/reports/ConsolidationIntercompany.tsx",
      "pages/reports/ConsolidatedTrialBalance.tsx",
    ]) {
      expect(read(rel)).not.toContain('from("consolidation_eliminations")');
    }
  });
});

describe("consolidation eliminations — wiring", () => {
  it("is registered as a report, routed, and reachable from navigation", () => {
    expect(read("services/reports/ReportRegistry.ts")).toContain("intercompany-eliminations");
    expect(read("services/reports/reportsNav.ts")).toContain("intercompany-eliminations");
    expect(read("apps/finance/routes.tsx")).toContain('path="reports/eliminations"');
    expect(read("components/layout/AppSidebar.tsx")).toContain(
      "/finance/reports/eliminations",
    );
    expect(read("lib/apps/registry.ts")).toContain("/finance/reports/eliminations");
  });

  it("the policy screen is mounted inside consolidation group settings", () => {
    expect(read("components/settings/ConsolidationGroupsSettings.tsx")).toContain(
      "<ConsolidationEliminationRules",
    );
  });
});
