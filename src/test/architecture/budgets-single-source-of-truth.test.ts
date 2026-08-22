import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 6 — Regression protection for the BUDGETS domain.
 *
 * These assertions encode the invariants the domain rework established:
 *
 *  1. A budget never posts journal entries.
 *  2. Actuals are derived server-side by one RPC; React consumes numbers and
 *     never aggregates the ledger.
 *  3. `fiscal_periods` is the period authority — not calendar month/year.
 *  4. Variance is favourable-positive and computed in SQL.
 *  5. No stored/materialised actuals table may come back.
 *
 * They are file-level assertions on purpose: they must fail loudly the moment
 * a future change re-introduces a client-side budget calculation, which is
 * exactly how the two contradictory implementations arose in the first place.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

/** The newest migration that (re)defines a given function. */
const latestDefining = (fn: string) =>
  [...migrations]
    .reverse()
    .find(({ sql }) =>
      new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\b`, "i").test(sql),
    );

describe("Budgets — actuals are server-derived", () => {
  it("the variance report is the only place the ledger is aggregated", () => {
    const mig = latestDefining("get_budget_variance_report");
    expect(mig, "get_budget_variance_report migration is missing").toBeDefined();
    const sql = mig!.sql;
    expect(sql).toMatch(/journal_entry_lines/i);
    expect(sql).toMatch(/SUM\s*\(/i);
  });

  it("no budget consumer aggregates journal lines in React", () => {
    const consumers = [
      "src/hooks/useBudgetVsActual.ts",
      "src/hooks/useFiscalPeriodDetail.ts",
      "src/hooks/useBudgets.ts",
    ];
    for (const file of consumers) {
      const src = read(file);
      expect(src, `${file} must not query journal_entry_lines directly`).not.toMatch(
        /from\(["']journal_entry_lines["']\)/,
      );
    }
  });

  it("the period-close screen consumes the authoritative budget RPC", () => {
    const src = read("src/hooks/useFiscalPeriodDetail.ts");
    expect(src).toMatch(/rpc\(\s*["']get_period_budget_variance["']/);
    // The contradictory local calculation must stay deleted.
    expect(src).not.toMatch(/from\(["']budget_items["']\)/);
    expect(src, "budget actuals must not be re-derived from GL movements").not.toMatch(
      /const\s+actual\s*=\s*actualMov/,
    );
    expect(src).toMatch(/budgetVarianceResult/);

  });

  it("no client code reads budget_items outside the budgets feature", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "test" || entry.name === "__tests__") continue;
          walk(rel);
        } else if (/\.tsx?$/.test(entry.name)) {
          if (rel.startsWith("src/features/finance/budgets")) continue;
          if (rel === "src/hooks/useBudgets.ts" || rel === "src/hooks/useBudgetRevisions.ts") continue;
          if (/from\(["']budget_items["']\)/.test(readFileSync(join(ROOT, rel), "utf8"))) {
            offenders.push(rel);
          }
        }
      }
    };
    walk("src");
    expect(offenders, `budget_items read outside the budgets feature: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the stored actuals table stays deleted", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "test" || entry.name === "__tests__") continue;
          walk(rel);
        } else if (/\.tsx?$/.test(entry.name) && /budget_actuals|recalculate_budget_actuals/.test(
          readFileSync(join(ROOT, rel), "utf8"),
        )) {
          offenders.push(rel);
        }
      }
    };
    walk("src");
    expect(offenders, `stored budget actuals resurrected in: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("Budgets — fiscal periods are the period authority", () => {
  const mig = latestDefining("get_budget_variance_report");

  it("the report joins plan to ledger on fiscal_period_id, not on a month number", () => {
    const sql = mig!.sql;
    expect(sql).toMatch(/fiscal_period_id/);
    expect(sql, "plan/ledger must not be matched on period_month").not.toMatch(
      /USING\s*\(\s*account_id\s*,\s*period_month\s*\)/i,
    );
  });

  it("the period set comes from a fiscal-year authority, not EXTRACT(YEAR ...)", () => {
    const sql = mig!.sql;
    expect(sql).toMatch(/budget_fiscal_months/);
  });

  it("a shared fiscal-month authority exists and honours non-January year starts", () => {
    const fm = latestDefining("budget_fiscal_months");
    expect(fm, "budget_fiscal_months is missing").toBeDefined();
    expect(fm!.sql).toMatch(/fiscal_year_start/);
    expect(fm!.sql).toMatch(/period_ordinal|ordinal/i);
  });

  it("the UI charts periods in fiscal order", () => {
    const src = read("src/hooks/useBudgetVsActual.ts");
    expect(src).toMatch(/period_ordinal/);
    expect(src).toMatch(/periodOrdinal/);
    expect(src).toMatch(/periodAxis/);
  });
});

describe("Budgets — ledger visibility and variance sign", () => {
  const mig = latestDefining("get_budget_variance_report");

  it("actuals include reversed entries via the platform visibility contract", () => {
    const sql = mig!.sql;
    expect(sql).toMatch(/ledger_visible_journal_statuses\(\)/);
    expect(sql, "must not hard-code status = 'posted'").not.toMatch(
      /je\.status\s*=\s*'posted'/i,
    );
  });

  it("variance sign is decided in SQL from the account's nature", () => {
    const sql = mig!.sql;
    expect(sql).toMatch(/is_favourable/);
    expect(sql).toMatch(/account_type/);
  });

  it("React never re-signs the variance it was given", () => {
    const page = read("src/pages/finance/FiscalPeriodDetail.tsx");
    expect(page).toMatch(/row\.favourable/);
    expect(page).not.toMatch(/row\.variance\s*>\s*0\s*\?\s*["'`]text-destructive/);
  });
});

describe("Budgets — posting stays non-blocking and operational-only", () => {
  const src = read("src/hooks/useGLPosting.ts");

  it("the budget check only warns; it never aborts the posting", () => {
    expect(src).toMatch(/check_budget_variance/);
    const block = src.slice(src.indexOf("check_budget_variance"));
    expect(block.slice(0, 1500)).not.toMatch(/throw new Error\([^)]*[Bb]udget/);
  });

  it("non-operational sources are excluded through the shared rule module", () => {
    expect(src).toMatch(/consumesBudget\(options\.source_type\)/);
    expect(src, "exclusions must not be hard-coded at the call site").not.toMatch(
      /source_type\s*!==\s*["']year_end_closing["']/,
    );
    const rules = read("src/lib/finance/budgetConsumption.ts");
    for (const source of ["year_end_closing", "opening_balance", "migration", "reversal"]) {
      expect(rules).toMatch(new RegExp(`"${source}"`));
    }
  });

  it("the budget check is scoped to the active business", () => {
    expect(src).toMatch(/_business_id:\s*currentBusiness\.id/);
  });
});

describe("Budgets — authorization", () => {
  it("the period-scoped report authorizes the caller before returning rows", () => {
    const mig = latestDefining("get_period_budget_variance");
    expect(mig, "get_period_budget_variance migration is missing").toBeDefined();
    const sql = mig!.sql;
    expect(sql).toMatch(/user_can_access_business/);
    expect(sql).toMatch(/42501/);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.get_period_budget_variance/i);
    expect(sql).not.toMatch(/GRANT\s+EXECUTE[\s\S]{0,80}TO\s+anon/i);
  });

  it("the full report refuses budgets the caller may not read", () => {
    const mig = latestDefining("get_budget_variance_report");
    expect(mig!.sql).toMatch(/_budget_assert_read|user_can_access_business|42501/);
  });

  it("the posting-time check enforces mandatory business scope", () => {
    const mig = latestDefining("check_budget_variance");
    expect(mig, "check_budget_variance migration is missing").toBeDefined();
    expect(mig!.sql).toMatch(/_business_id/);
    expect(mig!.sql).toMatch(/42501/);
  });
});

describe("Budgets — lifecycle is enforced in the database", () => {
  it("the lifecycle guard rejects illegal transitions", () => {
    const mig = latestDefining("_budgets_lifecycle_guard");
    expect(mig, "_budgets_lifecycle_guard migration is missing").toBeDefined();
    const sql = mig!.sql;
    expect(sql).toMatch(/draft/);
    expect(sql).toMatch(/active/);
    expect(sql).toMatch(/closed/);
    expect(sql).toMatch(/RAISE\s+EXCEPTION/i);
  });

  it("post-activation change is a numbered revision, not an in-place edit", () => {
    const hasRevisions = migrations.some(({ sql }) =>
      /CREATE\s+TABLE[\s\S]{0,120}public\.budget_revisions/i.test(sql),
    );
    expect(hasRevisions, "budget_revisions table migration is missing").toBe(true);
    const hook = read("src/hooks/useBudgetRevisions.ts");
    expect(hook).toMatch(/budget_revision/);
  });
});

describe("Budgets — income and expense are never netted in the UI", () => {
  it("the budget analysis chart plots revenue and cost as separate series", () => {
    const page = read("src/features/finance/budgets/BudgetEditPage.tsx");
    // A chart datum must never add an income figure to an expense figure:
    // income is credit-normal, expense is debit-normal.
    expect(page).not.toMatch(/point\.(budgeted|actual|variance)\s*\+\s*\(income/);
    expect(page).toMatch(/revenuePlan/);
    expect(page).toMatch(/costPlan/);
    expect(page).toMatch(/revenueActual/);
    expect(page).toMatch(/costActual/);
  });
});
