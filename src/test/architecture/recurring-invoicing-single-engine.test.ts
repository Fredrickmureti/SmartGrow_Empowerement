/**
 * Recurring invoicing — single-engine ratchet.
 *
 * `generate_recurring_invoice_occurrence` is the only thing allowed to create a
 * recurring invoice, post its journal entry or advance its schedule. Before the
 * convergence there were two engines (an edge worker and a browser hook) that
 * disagreed on numbering, GL accounts, traceability and status, so the same
 * template produced different financial outcomes depending on who triggered it.
 *
 * These assertions fail CI if either engine is reintroduced.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const WORKER = "supabase/functions/process-recurring-invoices/index.ts";
const HOOK = "src/hooks/useRecurringInvoices.ts";

describe("recurring invoicing: one generation engine", () => {
  it("the cron worker only drives the engine — it never builds invoices itself", () => {
    const src = read(WORKER);
    expect(src).toContain("generate_recurring_invoice_occurrence");
    expect(src).not.toMatch(/from\(["']invoices["']\)\s*\n?\s*\.insert/);
    expect(src).not.toMatch(/from\(["']invoice_items["']\)/);
    expect(src).not.toContain("post_journal_entry_atomic");
    expect(src).not.toContain("get_next_invoice_number");
  });

  it("the cron worker does not mutate the schedule (the engine owns advancement)", () => {
    const src = read(WORKER);
    expect(src).not.toContain("next_run_date:");
    expect(src).not.toContain("last_run_date");
    expect(src).not.toContain("invoices_generated");
  });

  it("the cron worker does not recompute the recurrence calendar", () => {
    const src = read(WORKER);
    expect(src).not.toContain("function nextStart");
    expect(src).not.toContain("function periodEnd");
  });

  it("'Generate now' calls the same engine instead of a client-side copy", () => {
    const src = read(HOOK);
    expect(src).toContain("generate_recurring_invoice_now");
    expect(src).not.toContain("confirmInvoiceAndPostGL");
    expect(src).not.toMatch(/from\(["']invoices["']\)\s*\n?\s*\.insert/);
    expect(src).not.toMatch(/from\(["']invoice_items["']\)/);
    expect(src).not.toContain("get_next_invoice_number");
    expect(src).not.toContain("calculateNextRunDate");
  });

  it("delivery failure is recorded on the run, never on the invoice", () => {
    const src = read(WORKER);
    expect(src).toContain("delivery_status");
    // The worker must not rewrite invoice status as a side effect of emailing.
    expect(src).not.toMatch(/from\(["']invoices["']\)\s*\n?\s*\.update/);
  });
});
