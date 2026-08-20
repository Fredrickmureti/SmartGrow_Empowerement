/**
 * Guard: Sales Reports is server-owned.
 *
 * Sales measures are accounting output and belong in SQL
 * (`finance_sales_analysis`). The previous implementation loaded `invoices`
 * into the browser with `useInvoices()` and folded `inv.total` with `reduce`,
 * which ignored credit notes, returns, discounts and cost, mixed document
 * currencies, and counted unposted documents as revenue.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const PAGE = "src/pages/reports/SalesReports.tsx";
const SERVICE = "src/services/finance/salesAnalysis.ts";
const HOOK = "src/hooks/useSalesAnalysis.ts";

describe("Sales Reports — server-owned measures", () => {
  it("the page consumes the canonical hook", () => {
    const src = read(PAGE);
    expect(src).toContain("useSalesAnalysis");
    expect(src).toContain("useSalesRevenueReconciliation");
  });

  it("the page does not load invoices into the browser", () => {
    const src = read(PAGE);
    expect(src).not.toContain("useInvoices");
    expect(src).not.toContain("useInvoiceItems");
    expect(src).not.toMatch(/from\(["'`]invoices["'`]\)/);
    expect(src).not.toMatch(/from\(["'`]credit_notes["'`]\)/);
  });

  it("the page performs no invoice-total arithmetic", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/\.reduce\(/);
    expect(src).not.toMatch(/inv\.total/);
    expect(src).not.toMatch(/amount_paid/);
  });

  it("the page never re-aggregates rows into a footer", () => {
    const src = read(PAGE);
    // Grand totals come from the engine's totals envelope only.
    expect(src).toContain("totals.net_after_returns");
    expect(src).not.toMatch(/rows\.reduce/);
  });

  it("the export uses the shared column declaration, not a hand-built payload", () => {
    const src = read(PAGE);
    expect(src).toContain("toExportColumns(columns)");
    expect(src).toContain("toExportRows(rows, columns)");
    expect(src).not.toContain("_isSubtotal");
    expect(src).not.toContain("_isHeader");
  });

  it("the service is the only caller of the sales RPCs", () => {
    const service = read(SERVICE);
    expect(service).toContain('"finance_sales_analysis"');
    expect(service).toContain('"finance_sales_revenue_reconciliation"');
    // The page and hook may *name* the engine in prose, but must never invoke it.
    for (const file of [PAGE, HOOK]) {
      expect(read(file)).not.toMatch(/\.rpc\s*(as any\)?)?\s*\(/);
      expect(read(file)).not.toMatch(/rpc\(["'`]finance_sales/);
    }
  });


  it("the hook and page never touch the supabase client directly", () => {
    for (const file of [PAGE, HOOK]) {
      expect(read(file)).not.toContain("@/integrations/supabase/client");
    }
  });

  it("the dimension list is closed — the engine rejects anything else", () => {
    const service = read(SERVICE);
    for (const d of ["customer", "product", "category", "branch", "salesperson", "month"]) {
      expect(service).toContain(`"${d}"`);
    }
    expect(service).toContain("isSalesDimension");
  });
});
