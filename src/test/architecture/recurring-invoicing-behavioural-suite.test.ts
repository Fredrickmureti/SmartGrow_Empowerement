/**
 * Recurring invoicing — behavioural suite ratchet.
 *
 * The billing engine is a database function, so its behavioural tests are
 * database functions too (`test_recurring_calendar`, `test_recurring_invoicing_engine`).
 * The engine suite writes real templates, invoices and journal entries inside a
 * subtransaction that is always rolled back, so it can be run against live data
 * without consuming invoice numbers.
 *
 * These assertions fail CI if the suites, their runner, or the guarantees they
 * cover are deleted from the repository.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");

const allMigrationSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(resolve(MIGRATIONS, f), "utf8"))
  .join("\n");

const RUNNER = readFileSync(
  resolve(process.cwd(), "supabase/functions/run-recurring-invoice-tests/index.ts"),
  "utf8",
);

describe("recurring invoicing: behavioural test suites live in the database", () => {
  it("both suites are defined", () => {
    expect(allMigrationSql).toContain("FUNCTION public.test_recurring_calendar()");
    expect(allMigrationSql).toContain("FUNCTION public.test_recurring_invoicing_engine()");
    expect(allMigrationSql).toContain("FUNCTION public._recurring_engine_scenarios()");
  });

  it("the engine suite always rolls back its writes", () => {
    expect(allMigrationSql).toContain("recurring_test_rollback");
  });

  it("the suites are not callable by application users", () => {
    expect(allMigrationSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.test_recurring_invoicing_engine\(\) FROM PUBLIC, anon, authenticated/,
    );
    expect(allMigrationSql).toMatch(
      /REVOKE ALL ON FUNCTION public\._recurring_engine_scenarios\(\) FROM PUBLIC, anon, authenticated/,
    );
  });

  it("every guarantee from the convergence plan is covered by a named case", () => {
    for (const assertion of [
      "concurrency: (template, period_start) is uniquely indexed",
      "idempotency: repeating the same period yields one invoice",
      "crash-resume: replaying an interrupted period does not duplicate",
      "failure: a broken template leaves the schedule untouched",
      "isolation: one broken template does not block another",
      "end date: the final due period is billed, then the schedule completes",
      "end date: periods past the end date are refused",
      "accounting: the journal entry balances",
      "accounting: the entry is sourced from the invoice like a manual one",
      "traceability: every generated invoice points back to its template",
    ]) {
      expect(allMigrationSql).toContain(assertion);
    }
  });

  it("the calendar suite covers month-end, leap years and long frequencies", () => {
    for (const assertion of [
      "monthly: Jan 31 clamps to Feb 28 in a common year",
      "monthly: Feb 28 returns to the 31st (no permanent drift)",
      "monthly: Jan 31 clamps to Feb 29 in a leap year",
      "quarterly: Jan 31 clamps to Apr 30",
      "yearly: Feb 29 clamps to Feb 28 the next year",
      "weekly: advances seven days across a month boundary",
    ]) {
      expect(allMigrationSql).toContain(assertion);
    }
  });

  it("the runner is service-role only and reports failures", () => {
    expect(RUNNER).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(RUNNER).toContain("test_recurring_invoicing_engine");
    expect(RUNNER).toContain("test_recurring_calendar");
    expect(RUNNER).toContain("forbidden");
  });
});
