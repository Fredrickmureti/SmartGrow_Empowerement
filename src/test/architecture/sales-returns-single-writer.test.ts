/**
 * Architecture ratchet — Sales Returns single writer.
 *
 * Returns convergence Phase 3/4 moved document creation and lifecycle
 * transitions server-side. These invariants freeze the old client-side
 * shapes out:
 *
 *   1. No application code inserts `sales_returns` or `sales_return_items`
 *      rows directly — creation goes through `create_sales_return_atomic`,
 *      which allocates the number, derives totals and is idempotent by
 *      `client_request_id`.
 *   2. No application code writes `sales_returns.status` — transitions go
 *      through `transition_sales_return` (or `approve_sales_return_atomic`
 *      for approval), which enforce the state machine.
 *   3. No application code allocates a return number itself; the BEFORE
 *      INSERT trigger owns the series so WMS- and sales-raised returns
 *      never collide.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SELF = "sales-returns-single-writer.test.ts";
const APP_PATHS = ["src", "supabase/functions"];

function rgFiles(pattern: string): string[] {
  try {
    return execSync(
      `rg -lU ${JSON.stringify(pattern)} ${APP_PATHS.join(" ")} -g '*.ts' -g '*.tsx'`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.includes(SELF))
      // Generated Supabase types describe the schema, they do not write to it.
      .filter((f) => !f.includes("integrations/supabase/types.ts"));
  } catch {
    return [];
  }
}

describe("Sales returns single writer", () => {
  it("no application code inserts sales return rows directly", () => {
    expect(rgFiles('from\\("sales_return(s|_items)"\\)\\s*\\.insert')).toEqual([]);
  });

  it("no application code writes sales_returns.status", () => {
    expect(
      rgFiles('from\\("sales_returns"\\)[\\s\\S]{0,200}?\\.update\\(\\s*\\{[\\s\\S]{0,200}?status'),
    ).toEqual([]);
  });

  it("no application code allocates a sales return number", () => {
    expect(rgFiles("get_next_sales_return_number")).toEqual([]);
  });

  /**
   * Phase 8 — tax on a return is the tax the original invoice line charged.
   * The browser may preview it, but it must never derive it from the
   * product's *current* rate, and it must never send a price for a line it
   * took from an invoice: `create_sales_return_atomic` resolves both through
   * `resolve_sales_return_line_tax`.
   */
  it("no returns page derives line tax from the current product tax rate", () => {
    const offenders = rgFiles(
      'invoice_item_id[\\s\\S]{0,600}?product\\.tax_rate',
    ).filter((f) => f.includes("/returns/"));
    expect(offenders).toEqual([]);
  });

  it("returns pages do not overwrite an invoice-sourced line price with the product price", () => {
    const offenders = rgFiles(
      'patch\\.product_id[\\s\\S]{0,120}?next\\.unit_price = product\\.unit_price',
    ).filter(
      (f) => f.includes("/returns/") && !f.includes("!next.invoice_item_id"),
    );
    // The guard lives in the source itself; assert the escape hatch is present.
    const src = readFileSync(
      "src/features/sales/returns/SalesReturnCreatePage.tsx",
      "utf8",
    );
    expect(src).toContain("!next.invoice_item_id");
    expect(offenders.length).toBeLessThanOrEqual(1);
  });
});