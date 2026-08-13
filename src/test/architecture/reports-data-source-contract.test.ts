/**
 * Phase A4 — Report data-source contract test.
 *
 * Financial reports MUST source their numbers from posted journal-entry
 * lines (via the GL RPCs), NOT from operational/transactional tables such
 * as `invoices`, `payments`, `expenses`, `bills`. Bypassing the GL is what
 * produced the 497M "Platform Revenue" artifact on the platform admin
 * dashboard — same bug class is no longer permitted inside finance reports.
 *
 * The check is intentionally narrow: it scans the page files under
 * `src/pages/reports/` that are flagged as "financial" by the registry and
 * fails if any of them touch a forbidden table directly via the supabase
 * client. Drill-down detail dialogs are allowed to read source tables, but
 * the top-level financial summaries must not.
 *
 * If you need to add a new financial report, source it from one of:
 *   - `get_general_ledger`
 *   - `get_account_balances` / `get_account_balance_at_date`
 *   - `get_account_movements`
 *   - `get_gl_transactions`
 *   - `get_ap_aging_summary`
 *   - `get_control_account_reconciliation`
 *   - `check_balance_integrity`
 *
 * Non-financial reports (sales-by-product, aging-by-customer, stock, POS,
 * HR/payroll registers) are exempt — they legitimately read operational
 * tables.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Files whose primary KPIs must come from GL, not operational tables. */
const FINANCIAL_REPORT_FILES = [
  "src/pages/reports/FinancialReports.tsx",
  "src/pages/reports/TrialBalance.tsx",
  "src/pages/reports/GeneralLedger.tsx",
  "src/pages/reports/JournalReport.tsx",
  "src/pages/reports/CashFlowReport.tsx",
];

/** Operational tables a financial report must NOT query directly. */
const FORBIDDEN_TABLES = [
  "invoices",
  "invoice_items",
  "payments",
  "payment_allocations",
  "bill_payments",
  "expenses",
  "purchases",
  "purchase_orders",
];

function read(rel: string): string | null {
  const full = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}

describe("financial reports must source from the General Ledger", () => {
  for (const file of FINANCIAL_REPORT_FILES) {
    it(`${file} does not query forbidden operational tables directly`, () => {
      const src = read(file);
      if (src == null) {
        // Page not present in this branch — skip silently rather than fail.
        return;
      }
      const violations: string[] = [];
      for (const table of FORBIDDEN_TABLES) {
        // Match `.from("invoices")` / `.from('invoices')` patterns only.
        const re = new RegExp(`\\.from\\(\\s*['\"\`]${table}['\"\`]\\s*\\)`);
        if (re.test(src)) violations.push(table);
      }
      expect(
        violations,
        `${file} reads operational tables directly (${violations.join(", ")}). ` +
          `Financial KPIs must come from the General Ledger RPCs ` +
          `(get_general_ledger, get_account_balances, get_gl_transactions, etc.). ` +
          `See src/test/architecture/reports-data-source-contract.test.ts for the contract.`,
      ).toEqual([]);
    });
  }
});

/**
 * ADR 0033 — the legacy document-only open-items views were rewritten as
 * GL-gated projections. Application code (reports / hooks) must consume the
 * RPCs that wrap them (`get_ar_ap_aging_from_ledger`,
 * `get_control_account_reconciliation`) rather than reading the views
 * directly. Catching direct reads here prevents a future regression where a
 * new report bypasses the RPC and re-introduces document-only logic.
 */
const LEGACY_OPEN_ITEMS_VIEWS = ["finance_ar_open_items", "finance_ap_open_items"];

function walk(dir: string, acc: string[] = []): string[] {
  const full = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(full)) return acc;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(rel);
  }
  return acc;
}

describe("AR/AP open-items views are consumed via RPCs, not directly", () => {
  const files = [...walk("src/pages/reports"), ...walk("src/hooks")];
  for (const view of LEGACY_OPEN_ITEMS_VIEWS) {
    it(`no component or hook reads ${view} via .from(...)`, () => {
      const re = new RegExp(`\\.from\\(\\s*['\"\`]${view}['\"\`]\\s*\\)`);
      const offenders = files.filter((f) => {
        const src = read(f);
        return src != null && re.test(src);
      });
      expect(
        offenders,
        `${view} must be read only through get_ar_ap_aging_from_ledger / ` +
          `get_control_account_reconciliation. Direct reads found in: ` +
          offenders.join(", "),
      ).toEqual([]);
    });
  }
});

/**
 * Phase 10 — `finance_ap_open_items` is dropped from the database entirely.
 * The only payables projection is `finance_ap_open_items_as_of`, and the
 * projection/ledger drift sensor (`finance_open_items_tieout`) computes its AP
 * side inline. Any reference to the retired view — application read or SQL —
 * silently loses point-in-time ability: it could only ever answer "today", so a
 * statement or aging reprint for a closed period would be wrong.
 */
describe("no application code reads the retired finance_ap_open_items view", () => {
  const files = [...walk("src"), ...walk("supabase/functions")].filter(
    (f) => !f.includes(path.join("src", "test")) && !f.endsWith("types.ts"),
  );
  it("every payables read goes through finance_ap_open_items_as_of", () => {
    const re = /(?:\.from|\.rpc)\(\s*["'`]finance_ap_open_items["'`]/;
    const offenders = files.filter((f) => {
      const src = read(f);
      return src != null && re.test(src);
    });
    expect(
      offenders,
      "finance_ap_open_items is retired — call the finance_ap_open_items_as_of " +
        "RPC (see src/services/finance/openItems.ts). Offenders: " +
        offenders.join(", "),
    ).toEqual([]);
  });
});

