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

  it("a branch-scoped run must not add the business-level opening balance", () => {
    // `accounts.opening_balance` is a business-level property. Adding it to a
    // branch run double-counts the company opening into one branch.
    expect(read(ENGINE)).toMatch(/branchId\s*\?\s*0\s*:/);
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
