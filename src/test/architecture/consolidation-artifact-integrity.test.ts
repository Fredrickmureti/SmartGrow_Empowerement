import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 6 — report artifact integrity.
 *
 * An exported consolidation artifact is read outside the app, often by an
 * auditor who cannot see the screen it came from. It must therefore carry the
 * same identity, the same caveats and the same numbers as the surface that
 * produced it — and it must be produced by the one branded export pipeline, so
 * no page can invent its own masthead or company identity.
 */
const read = (rel: string) =>
  readFileSync(join(process.cwd(), "src", rel), "utf8");

const SURFACES = [
  "pages/reports/Consolidation.tsx",
  "pages/reports/ConsolidatedTrialBalance.tsx",
  "pages/reports/ConsolidatedStatements.tsx",
  "pages/reports/ConsolidationIntercompany.tsx",
  "pages/reports/ConsolidationEliminations.tsx",
] as const;

describe("consolidation exports go through the one branded pipeline", () => {
  it.each(SURFACES)("%s exports via ReportExportButtons + ExportConfig", (rel) => {
    const src = read(rel);
    expect(src).toContain("ReportExportButtons");
    expect(src).toContain("ExportConfig");
    // No page-level file writing, no ad-hoc CSV assembly.
    expect(src).not.toContain("URL.createObjectURL");
    expect(src).not.toMatch(/new Blob\(/);
    expect(src).not.toContain("jsPDF");
  });

  it.each(SURFACES)("%s never overrides branding or company identity", (rel) => {
    const src = read(rel);
    // `companyName` was removed from ExportConfig precisely so a page cannot
    // brand its own artifact; branding is injected server-side.
    expect(src).not.toMatch(/companyName\s*:/);
    expect(src).not.toMatch(/organizationId\s*:\s*/);
  });

  it.each(SURFACES)("%s stamps the artifact with its reporting period", (rel) => {
    const src = read(rel);
    // Range reports carry `dateRange`, point-in-time reports carry `asOf`.
    expect(src).toMatch(/dateRange:|asOf:/);
    expect(src).toMatch(/title:/);
  });
});

describe("artifacts repeat the caveats the screen shows", () => {
  it("the comparative export refuses to imply a consolidation", () => {
    const src = read("pages/reports/Consolidation.tsx");
    // Same wording as the on-screen banner: no summing across currencies.
    expect(src).toContain("Not a consolidation");
    expect(src).toContain("not summed, translated or eliminated");
    // The currencies actually present are named in the artifact.
    expect(src).toContain("currencies.join");
  });

  it("comparative amounts are exported per company in that company's currency", () => {
    const src = read("pages/reports/Consolidation.tsx");
    expect(src).toContain("formatMoney(r.income, r.currency)");
    expect(src).toContain("formatMoney(r.expense, r.currency)");
    expect(src).toContain("formatMoney(r.netIncome, r.currency)");
  });
});

describe("the server, not the client, decides cross-entity ledger access", () => {
  it("the entity-scoped drill always names the company it reads", () => {
    const src = read("components/reports/DrillDownDialog.tsx");
    // `get_general_ledger` enforces finance_can_read_scope /
    // finance_can_read_financials for the named business, so passing the
    // member's id is what makes the read safe — never a client-side filter.
    expect(src).toContain("get_general_ledger");
    expect(src).toContain("_business_id");
    expect(src).toContain("businessId");
  });
});
