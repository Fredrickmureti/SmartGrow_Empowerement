/**
 * AP statement guards — the vendor side must not regress to the shapes the
 * audit removed:
 *
 *   1. A bulk cohort rebuilt from `bills.status`, which invents debt for
 *      unposted bills and hides payables born of manual journals.
 *   2. A browser `for` loop emailing suppliers, where closing the tab
 *      truncates the run and nothing is retried or idempotent.
 *   3. A non-atomic client insert into `vendor_statements`, which lets two
 *      runs of the same period mint duplicate statements.
 *   4. A statement routed to the invoice template, which is how a ledger
 *      acquired "Bill To" and an item table.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("vendor statement durability", () => {
  const page = read("src/pages/VendorStatements.tsx");

  it("builds the bulk cohort from canonical AP, not bill status", () => {
    expect(page).toContain("fetchPayableCounterparties");
    expect(page).not.toMatch(/from\("bills"\)[\s\S]{0,400}?\.in\("status"/);
  });

  it("enqueues bulk sends instead of invoking the email function per row", () => {
    expect(page).toContain("enqueue_vendor_statement_send");
    const start = page.indexOf("const handleBulkGenerate");
    expect(start).toBeGreaterThan(-1);
    const bulk = page.slice(start, start + 4000);
    expect(bulk).not.toContain('functions.invoke("send-document-email"');
  });

  it("saves statements through the atomic upsert, never a raw insert", () => {
    const hook = read("src/hooks/useVendorStatements.ts");
    expect(hook).toContain("upsert_vendor_statement_atomic");
    expect(hook).not.toMatch(/from\("vendor_statements"\)\s*\n?\s*\.insert\(/);
  });

  it("downloads through the single dispatch exit", () => {
    expect(page).toContain("downloadVendorStatement");
    expect(page).not.toMatch(/downloadExport\(\{[\s\S]{0,200}?vendor_statement/);
    const dispatch = read("src/features/purchases/statements/dispatchVendorStatement.ts");
    expect(dispatch).toContain("export async function downloadVendorStatement");
  });

  it("drains the vendor statement queue from the scheduled worker", () => {
    const worker = read("supabase/functions/process-scheduled-automations/index.ts");
    expect(worker).toContain("flushVendorStatementSendOutbox");
  });

  it("never maps a statement kind onto the invoice template", () => {
    const gen = read("supabase/functions/generate-document/index.ts");
    const map = gen.slice(
      gen.indexOf("const TEMPLATE_TYPE_MAP"),
      gen.indexOf("const TEMPLATE_TYPE_MAP") + 3000,
    );
    for (const kind of ["customer_statement", "vendor_statement", "legal_recipient_statement"]) {
      expect(map).not.toContain(`${kind}: "invoice"`);
    }
  });
});
