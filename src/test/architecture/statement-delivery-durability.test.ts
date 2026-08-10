/**
 * Wave 7 guards — statement delivery must stay durable and canonical.
 *
 * Two regressions are cheap to reintroduce and expensive in production:
 *   1. Rebuilding the bulk statement cohort from `invoices.status`, which
 *      invents debt for unposted documents and hides manual-journal AR.
 *   2. Sending a batch of emails from a browser `for` loop, where closing the
 *      tab truncates the run and nothing is retried or idempotent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("statement delivery durability", () => {
  const statements = read("src/pages/CustomerStatements.tsx");

  it("builds the bulk cohort from canonical AR, not invoice status", () => {
    expect(statements).toContain("fetchReceivableCounterparties");
    expect(statements).not.toMatch(/from\("invoices"\)[\s\S]{0,400}?\.in\("status"/);
  });

  it("enqueues bulk sends instead of invoking the email function per row", () => {
    expect(statements).toContain("enqueue_customer_statement_send");
    const bulk = statements.slice(
      statements.indexOf("const handleBulkGenerate"),
      statements.indexOf("const handleBulkGenerate") + 4000,
    );
    expect(bulk).not.toContain('functions.invoke("send-document-email"');
  });

  it("drains the statement queue from the scheduled worker", () => {
    const worker = read("supabase/functions/process-scheduled-automations/index.ts");
    expect(worker).toContain("flushStatementSendOutbox");
  });

  it("surfaces delivery outcomes on the collections screen", () => {
    const collections = read("src/pages/sales/Collections.tsx");
    expect(collections).toContain("useStatementDeliveryStatus");
  });
});
