/**
 * A report's export must resolve its columns and format profile from the
 * server-side registry, not from whatever the page happened to ship.
 *
 * `supabase/functions/_shared/reports/columnSpecs.ts` is the one place a
 * report's canonical columns, headers, alignment and number formats live.
 * `render-report` only consults it when the client sends
 * `ExportConfig.reportType`. A page that omits the key silently falls back
 * to client-supplied columns, so its PDF/CSV/XLSX can drift away from the
 * registry (and away from the same report rendered by the scheduler, which
 * always goes through the registry).
 *
 * These guards keep every finance report that HAS a registry entry wired to
 * it, and keep pages from inventing registry keys that do not exist.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPORT_PAGES_DIR = path.resolve(process.cwd(), "src/pages/reports");
const COLUMN_SPECS = path.resolve(
  process.cwd(),
  "supabase/functions/_shared/reports/columnSpecs.ts",
);

/**
 * Pages whose report is described in the server registry. Each must pass
 * the listed key as `ExportConfig.reportType`. This list only ever grows:
 * adding a registry entry for a report means wiring its page here.
 */
const PAGE_REGISTRY_KEYS: Record<string, string> = {
  "TrialBalance.tsx": "trial_balance",
  "CashFlowReport.tsx": "cash_flow",
  "GeneralLedger.tsx": "general_ledger",
  "PartnerLedger.tsx": "partner_ledger",
  "JournalReport.tsx": "journal_report",
  "BudgetReport.tsx": "budget_vs_actual",
  "DepreciationReport.tsx": "depreciation_schedule",
  "AuditTrail.tsx": "audit_trail",
};

function readPage(file: string): string {
  return readFileSync(path.join(REPORT_PAGES_DIR, file), "utf8");
}

const registrySource = readFileSync(COLUMN_SPECS, "utf8");
const registryKeys = new Set(
  [...registrySource.matchAll(/^ {2}([a-z0-9_]+):\s*\{/gm)].map((m) => m[1]),
);

describe("report export configs resolve through the server column registry", () => {
  it("reads the registry (guard is actually running)", () => {
    expect(registryKeys.size).toBeGreaterThan(10);
    expect(registryKeys.has("trial_balance")).toBe(true);
  });

  it("every mapped page declares its registry key as ExportConfig.reportType", () => {
    const missing = Object.entries(PAGE_REGISTRY_KEYS).filter(
      ([file, key]) => !new RegExp(`reportType:\\s*"${key}"`).test(readPage(file)),
    );
    expect(
      missing.map(([file, key]) => `${file} must set reportType: "${key}"`),
      "Without reportType the export bypasses columnSpecs.ts and can drift from the registry",
    ).toEqual([]);
  });

  it("every registry key a page maps to exists in columnSpecs.ts", () => {
    const unknown = Object.entries(PAGE_REGISTRY_KEYS).filter(
      ([, key]) => !registryKeys.has(key),
    );
    expect(
      unknown.map(([file, key]) => `${file} maps to unknown registry key "${key}"`),
    ).toEqual([]);
  });
});
