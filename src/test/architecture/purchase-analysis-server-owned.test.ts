/**
 * Purchases reporting is server-owned.
 *
 * The Purchase Reports page must never fold bills in the browser: that
 * ignores vendor credit notes, header discounts and document currency, counts
 * unposted bills, and truncates at the client row limit. Every measure comes
 * from `finance_purchase_analysis`, and the GL tie-out from
 * `finance_purchase_expense_reconciliation`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const PAGE = "src/pages/reports/PurchaseReports.tsx";
const SERVICE = "src/services/finance/purchaseAnalysis.ts";
const HOOK = "src/hooks/usePurchaseAnalysis.ts";

describe("purchase analysis — client seam", () => {
  it("the service is the only caller of the purchase RPCs", () => {
    const service = read(SERVICE);
    expect(service).toContain("finance_purchase_analysis");
    expect(service).toContain("finance_purchase_expense_reconciliation");

    for (const rel of [PAGE, HOOK]) {
      expect(read(rel), `${rel} must not call the RPC directly`).not.toMatch(
        /supabase\.rpc/,
      );
    }
  });

  it("passes an explicit _org_id to both RPCs", () => {
    const service = read(SERVICE);
    const calls = service.split("supabase.rpc").slice(1);
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.slice(0, 500)).toMatch(/_org_id:/);
    }
  });

  it("keeps a closed, typed dimension list", () => {
    const service = read(SERVICE);
    for (const dim of ["supplier", "product", "category", "account", "branch", "month"]) {
      expect(service).toContain(`"${dim}"`);
    }
    expect(service).toContain("isPurchaseDimension");
  });
});

describe("purchase analysis — no accounting arithmetic in React", () => {
  const page = read(PAGE);

  it("does not load or fold bills in the browser", () => {
    expect(page).not.toMatch(/useBills|from\("bills"\)|from\('bills'\)/);
    expect(page, "no reduce over document amounts").not.toMatch(/\.reduce\(/);
  });

  it("renders the engine's totals envelope as the footer", () => {
    expect(page).toContain("grandTotal");
    expect(page).toMatch(/totals\.net_after_returns/);
  });

  it("exports the same unpaged dataset through the same columns", () => {
    expect(page).toContain("toExportColumns(columns)");
    expect(page).toContain("toExportRows(rows, columns)");
  });

  it("surfaces the GL variance instead of hiding it", () => {
    expect(page).toContain("usePurchaseExpenseReconciliation");
    expect(page).toMatch(/!reconciliation\.inBalance/);
  });

  it("only drills where a document-ownership relationship exists", () => {
    expect(page).toMatch(/dimension === "supplier"/);
    expect(page).toContain('sourceType: "bill"');
  });
});

describe("purchase analysis — SQL contract suite is present", () => {
  it("ships the engine contract test", () => {
    const sql = read("supabase/tests/purchase_analysis_engine_test.sql");
    expect(sql).toContain("finance_purchase_analysis");
    expect(sql).toContain("finance_purchase_expense_reconciliation");
    expect(sql).toContain("42501");
    expect(sql).toContain("finance_can_read_org");
  });
});
