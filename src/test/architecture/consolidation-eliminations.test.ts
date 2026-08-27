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
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line));
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
    // toAppError keeps the PostgrestError's message, details and hint — the
    // refusal reaches the screen in the database's own words, unedited.
    expect(src).toContain('toAppError(e, "The elimination run was refused").message');
    expect(src).toContain("setRefusal(message)");
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

/**
 * Brick 7.1 guard: a refusal carries its own remedy, and every judgement in
 * that remedy comes from the server.
 *
 * The failure this prevents is a client that reads the refusal *sentence* and
 * guesses what to do about it — string matching on prose that the database is
 * free to reword, offering an action the engine would then reject.
 */
describe("consolidation eliminations — refusal remedies", () => {
  const PANEL = "components/finance/EliminationRefusalPanel.tsx";
  const REMEDIES = "lib/finance/eliminationRemedies.ts";

  it("the diagnosis comes from the server's preflight RPC", () => {
    expect(read(HOOK)).toContain("consolidation_diagnose_eliminations");
    expect(read(PAGE)).toContain("useEliminationDiagnosis");
  });

  it("remedies are structured codes, never inferred from the refusal text", () => {
    for (const rel of [PANEL, REMEDIES, PAGE]) {
      const src = read(rel);
      // No prose sniffing of the database's words.
      expect(src).not.toMatch(/message\s*\.\s*(includes|match|indexOf|toLowerCase)/);
      expect(src).not.toMatch(/refusal\s*\.\s*(includes|match|indexOf|toLowerCase)/);
    }
    expect(read(PANEL)).toContain("row.remedies");
  });

  it("the panel shows the server's own message and never computes an amount", () => {
    const src = read(PANEL);
    expect(src).toContain("{row.message}");
    // The tolerance offered is the server's suggestion, not a local sum.
    expect(src).toContain("row.suggested_tolerance");
    expect(arithmeticOffenders(src)).toEqual([]);
  });

  it("only engine-valid remedies are applied in place; the rest are links", () => {
    const src = read(REMEDIES);
    expect(src).toContain("APPLICABLE_REMEDIES");
    expect(src).toContain("configure_cta_account");
    expect(src).toContain("configure_difference_account");
    // Applying a policy remedy goes through the same guarded rule upsert.
    expect(read(PANEL)).toContain("saveRule.mutateAsync");
  });

  it("the settings screen honours the group and class named in the link", () => {
    const settings = read("components/settings/ConsolidationGroupsSettings.tsx");
    expect(settings).toContain("consolidationGroup");
    expect(settings).toContain("eliminationClass");
    expect(settings).toContain('id="consolidation-translation-reserve"');
    expect(settings).toContain('id="consolidation-group-members"');
    expect(read(SETTINGS)).toContain("eliminationClassAnchor");
  });
});
