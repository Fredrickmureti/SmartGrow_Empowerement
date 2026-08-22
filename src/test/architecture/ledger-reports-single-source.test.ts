/**
 * Guard: Ledgers & Journals reporting has exactly one data source.
 *
 * Trial Balance, General Ledger and Journal Report — on screen AND in the
 * archived PDF — must read the same three server engines:
 *
 *   get_account_movements · get_general_ledger · get_journal_report
 *
 * The failure mode this locks out is the one that produced the wave: the
 * server PDF engine carried its own accounting math (its own posted-only
 * filter, its own 1000-row cap, its own opening-balance rule) and slowly
 * drifted away from the screen. A ledger document that disagrees with the
 * screen is worse than no document.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const ENGINE = "supabase/functions/_shared/reportDataEngine.ts";
const SPECS = "supabase/functions/_shared/reports/columnSpecs.ts";
const GL_PAGE = "src/pages/reports/GeneralLedger.tsx";
const GL_HOOK = "src/hooks/useGeneralLedger.ts";
const JR_PAGE = "src/pages/reports/JournalReport.tsx";
const TB_PAGE = "src/pages/reports/TrialBalance.tsx";
const TB_HOOK = "src/hooks/useFinancialReport.ts";

const LEDGER_RPCS = ["get_account_movements", "get_general_ledger", "get_journal_report"] as const;

describe("Ledgers & Journals — single accounting source", () => {
  it("the screens read the ledger RPCs, not the journal tables", () => {
    expect(read(GL_HOOK)).toContain("get_general_ledger");
    expect(read(JR_PAGE)).toContain("get_journal_report");
    expect(read(TB_HOOK)).toContain("get_account_movements");
  });

  it("the server report engine reads the same three RPCs", () => {
    const src = read(ENGINE);
    for (const rpc of LEDGER_RPCS) expect(src).toContain(rpc);
  });

  it("the server engine does not rebuild ledger math from raw journal tables", () => {
    const src = read(ENGINE);
    // Reading the tables for a ledger report is what caused the drift: the
    // posted-only filter and the 1000-row cap both lived in such a query.
    expect(src).not.toMatch(/from\(["']journal_entry_lines["']\)/);
    expect(src).not.toMatch(/from\(["']journal_entries["']\)/);
  });

  it("the ledger screens never aggregate journal lines in the browser", () => {
    for (const page of [GL_PAGE, JR_PAGE, TB_PAGE, GL_HOOK]) {
      const src = read(page);
      // A drill-down lookup by id is fine; selecting amounts is not.
      expect(src).not.toMatch(/from\(["']journal_entry_lines["']\)[\s\S]{0,120}debit/);
      expect(src).not.toMatch(/\.range\(/);
      expect(src).not.toMatch(/running_balance\s*\+=/);
      expect(src).not.toMatch(/opening_balance\s*\+=/);
    }
  });

  it("branch scoping is threaded into every ledger read", () => {
    expect(read(GL_HOOK)).toContain("_branch_id");
    expect(read(JR_PAGE)).toContain("_branch_id");
    expect(read(ENGINE)).toContain("_branch_id: branchId ?? null");
  });

  it("opening balances come from the one opening engine, never from local math", () => {
    // `accounts.opening_balance` is a business-level property and nominal
    // accounts must restart at the fiscal-year boundary. Both rules live in
    // `get_ledger_opening_balances`; no runtime may re-derive them, and both
    // must pass the branch through so a branch run suppresses the company
    // opening instead of double-counting it into one branch.
    for (const src of [read(ENGINE), read(TB_HOOK)]) {
      expect(src).toContain("get_ledger_opening_balances");
      expect(src).toMatch(/_branch_id:\s*branchId\s*\?\?\s*null/);
      // No client-side reconstruction of an opening figure.
      expect(src).not.toMatch(/openingBalance\s*[+-]=/);
      expect(src).not.toMatch(/opening_balance\s*[+-]=/);
    }
  });


  it("the PDF column spec matches the on-screen columns", () => {
    const specs = read(SPECS);
    const glSpec = specs.slice(specs.indexOf("general_ledger: {"), specs.indexOf("partner_ledger: {"));
    for (const key of ["date", "entry", "journal", "description", "status", "debit", "credit", "balance"]) {
      expect(glSpec).toContain(`key: "${key}"`);
    }

    const jrStart = specs.indexOf("journal_report: {");
    const jrSpec = specs.slice(jrStart, specs.indexOf("budget_vs_actual: {", jrStart));
    for (const key of ["account", "description", "source", "debit", "credit"]) {
      expect(jrSpec).toContain(`key: "${key}"`);
    }

    const tbStart = specs.indexOf("trial_balance: {");
    const tbSpec = specs.slice(tbStart, specs.indexOf("income_statement: {", tbStart));
    for (const key of ["code", "name", "open_dr", "open_cr", "mov_dr", "mov_cr", "close_dr", "close_cr"]) {
      expect(tbSpec).toContain(`key: "${key}"`);
    }
  });

  it("the trial balance never carries original-currency columns", () => {
    // A trial balance in mixed units does not balance: base currency only.
    const specs = read(SPECS);
    const tbStart = specs.indexOf("trial_balance: {");
    const tbSpec = specs.slice(tbStart, specs.indexOf("income_statement: {", tbStart));
    expect(tbSpec).not.toContain("original");
  });
});

/**
 * Phase 6 — multi-currency presentation.
 *
 * Base currency is the authority: debits, credits, balances and every total
 * on a ledger document are base currency, always. Foreign-currency values are
 * a supplement (currency · document amount · rate) that appears only when the
 * run holds a foreign line, and never participates in arithmetic. Trial
 * Balance gains no FX columns — a trial balance in mixed units cannot balance.
 */
describe("Ledgers & Journals — multi-currency presentation", () => {
  const CLIENT_FX = "src/lib/reports/currencyPresentation.ts";
  const SERVER_FX = "supabase/functions/_shared/reports/currencyPresentation.ts";

  it("screen and server share one presentation rule, mirrored in both runtimes", () => {
    for (const path of [CLIENT_FX, SERVER_FX]) {
      const src = read(path);
      for (const fn of ["isForeignLine", "hasForeignCurrency", "formatDocumentAmount", "baseCurrencyNote"]) {
        expect(src, `${path} must export ${fn}`).toContain(`export function ${fn}`);
      }
    }
  });

  it("GL and Journal show the supplement conditionally, on screen and in the PDF", () => {
    for (const page of [GL_PAGE, JR_PAGE]) {
      const src = read(page);
      expect(src).toContain("hasForeignCurrency");
      expect(src).toContain("doc_amount");
      expect(src).toContain("fx_rate");
    }
    const engine = read(ENGINE);
    expect(engine).toContain("fxCells");
    expect(engine).toContain("withFxColumns");
  });

  it("the money columns stay base currency — FX values never feed a total", () => {
    const engine = read(ENGINE);
    // Totals accumulate `debit`/`credit` only; no original_* value is summed.
    expect(engine).not.toMatch(/(totalDebits|grandDebit|totalDebit)\s*\+=\s*[^;]*original_/);
    expect(engine).not.toMatch(/(totalCredits|grandCredit|totalCredit)\s*\+=\s*[^;]*original_/);
  });

  it("Trial Balance never gains currency columns", () => {
    const src = read(TB_PAGE);
    expect(src).not.toContain("doc_amount");
    expect(src).not.toContain("fx_rate");
  });

  it("builder-supplied columns reach the PDF renderer", () => {
    expect(read("supabase/functions/render-report/index.ts")).toMatch(
      /columns:\s*\(result as \{[^}]*columns/,
    );
  });
});

/**
 * Phase 7.1 — one drill-through rule for the three ledger surfaces.
 *
 * Trial Balance, General Ledger and Journal Report drill into the same
 * accounting object, so they must resolve the target through the same
 * function. The historical failure was three variants: GL resolved the entry
 * with a raw `journal_entry_lines` read in the browser, Journal Report
 * special-cased "manual" on its own, and the Trial Balance dialog drilled
 * without the report's branch scope.
 */
describe("Ledgers & Journals — drill-through consistency", () => {
  const RESOLVER = "src/lib/reports/ledgerDrillTarget.ts";
  const DIALOG = "src/components/reports/DrillDownDialog.tsx";

  it("all three ledger surfaces use the shared resolver", () => {
    for (const path of [GL_PAGE, JR_PAGE, DIALOG]) {
      expect(read(path), `${path} must resolve drill targets centrally`).toContain(
        "resolveLedgerDrillTarget",
      );
    }
    expect(read(RESOLVER)).toContain("export function resolveLedgerDrillTarget");
  });

  it("no reporting screen resolves a journal entry by reading journal tables", () => {
    for (const path of [GL_PAGE, JR_PAGE, TB_PAGE, GL_HOOK, DIALOG]) {
      expect(read(path)).not.toMatch(/from\(["']journal_entry_lines["']\)/);
      expect(read(path)).not.toMatch(/from\(["']journal_entries["']\)/);
    }
  });

  it("the entry id comes from the engine, not the browser", () => {
    expect(read(GL_HOOK)).toContain("journal_entry_id");
    expect(read(GL_PAGE)).toContain("_journalEntryId");
  });

  it("Trial Balance drill-down inherits the report's branch scope", () => {
    expect(read(TB_PAGE)).toMatch(/branchId:\s*filters\.branchId/);
    const dialog = read(DIALOG);
    expect(dialog).toContain("_branch_id: config.branchId || null");
  });
});
