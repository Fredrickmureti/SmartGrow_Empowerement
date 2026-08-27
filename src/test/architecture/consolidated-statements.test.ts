/**
 * Brick 5 invariants — consolidated income statement and balance sheet.
 *
 * The statements must stay a *projection* of the consolidated trial balance:
 * the server owns every figure, including the totals and the balance verdict,
 * the client only regroups rows, and the capability is reachable from the
 * reports catalogue rather than built and hidden.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sectionsOf,
  CONSOLIDATED_SECTION_LABELS,
  type ConsolidatedStatementLine,
} from "@/hooks/finance/useConsolidatedStatements";

const root = process.cwd();
const hookSource = readFileSync(
  join(root, "src/hooks/finance/useConsolidatedStatements.ts"),
  "utf8",
);
const pageSource = readFileSync(
  join(root, "src/pages/reports/ConsolidatedStatements.tsx"),
  "utf8",
);
const appSource = readFileSync(join(root, "src/App.tsx"), "utf8");
const registrySource = readFileSync(
  join(root, "src/services/reports/ReportRegistry.ts"),
  "utf8",
);
const types = readFileSync(join(root, "src/integrations/supabase/types.ts"), "utf8");

function line(over: Partial<ConsolidatedStatementLine>): ConsolidatedStatementLine {
  return {
    statement: "income_statement",
    section: "income",
    section_order: 1,
    account_id: "a",
    account_code: "4000",
    account_name: "Revenue",
    account_type: "income",
    is_residual: false,
    is_derived: false,
    presentation_currency: "KES",
    amount: 100,
    ...over,
  };
}

describe("consolidated statements — server owns the arithmetic", () => {
  it("reads the statement projections and nothing lower", () => {
    expect(hookSource).toContain('"get_consolidated_statement_lines"');
    expect(hookSource).toContain('"get_consolidated_statement_totals"');
    expect(hookSource).not.toContain("journal_entry_lines");
    expect(hookSource).not.toContain("exchange_rates");
  });

  it("exposes both RPCs in the generated database types", () => {
    expect(types).toContain("get_consolidated_statement_lines");
    expect(types).toContain("get_consolidated_statement_totals");
  });

  it("does not decide whether the balance sheet balances in the client", () => {
    // The verdict is the server's `is_balanced`; the page reports it.
    expect(pageSource).toContain("totals.is_balanced");
    expect(pageSource).not.toMatch(/total_assets\s*[-+]\s*total_liabilities/);
    expect(hookSource).not.toMatch(/total_assets\s*[-+]/);
  });

  it("does not re-total the statement lines in the client", () => {
    expect(pageSource).not.toMatch(/reduce\(/);
    expect(hookSource).not.toMatch(/reduce\(/);
  });
});

describe("consolidated statements — grouping helper", () => {
  it("keeps the server's order and splits by section", () => {
    const grouped = sectionsOf(
      [
        line({}),
        line({ account_id: "b", account_code: "4100" }),
        line({ section: "expense", section_order: 2, account_type: "expense", account_id: "c" }),
        line({ statement: "balance_sheet", section: "asset", account_id: "d" }),
      ],
      "income_statement",
    );
    expect(grouped.map((g) => g.section)).toEqual(["income", "expense"]);
    expect(grouped[0].lines.map((l) => l.account_code)).toEqual(["4000", "4100"]);
  });

  it("labels every section it can emit", () => {
    for (const section of ["income", "expense", "asset", "liability", "equity"] as const) {
      expect(CONSOLIDATED_SECTION_LABELS[section]).toBeTruthy();
    }
  });
});

describe("consolidated statements — reachable and honest", () => {
  it("is routed and listed in the reports catalogue", () => {
    expect(appSource).toContain("/reports/consolidated-statements");
    expect(registrySource).toContain("/reports/consolidated-statements");
  });

  it("states the limits it has rather than implying eliminations exist", () => {
    expect(pageSource).toContain("Intercompany balances are not yet eliminated");
  });

  it("surfaces engine refusals instead of rendering a number anyway", () => {
    expect(pageSource).toContain("describeConsolidationBlocker");
    expect(pageSource).toContain("dataError");
  });
});
