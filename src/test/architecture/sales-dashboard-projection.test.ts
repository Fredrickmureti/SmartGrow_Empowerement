/**
 * Sales Overview must stay a projection.
 *
 * The dashboard RPC and page may not re-derive AR figures. Receivables and
 * aging come from `finance_ar_net_position`, credit from
 * `finance_ar_customer_credit` (via that view), cash from
 * `payment_allocations`, and open fulfilment from `so_line_balances`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const FN = "get_sales_dashboard_kpis";

function latestDashboardFunctionSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(MIGRATIONS_DIR, files[i]), "utf8");
    if (sql.includes(`FUNCTION public.${FN}`)) return sql;
  }
  throw new Error(`no migration defines ${FN}`);
}

describe("sales dashboard is a projection, not a source of truth", () => {
  const sql = latestDashboardFunctionSql();

  it("does not read customer_credit_balances directly", () => {
    expect(sql).not.toMatch(/customer_credit_balances/);
  });

  it("never sums document-currency residual_amount", () => {
    expect(sql).not.toMatch(/SUM\(\s*o?\.?residual_amount/i);
  });

  it("reads receivables and aging from finance_ar_net_position", () => {
    expect(sql).toMatch(/finance_ar_net_position\b/);
  });

  it("derives cash from payment_allocations", () => {
    expect(sql).toMatch(/payment_allocations/);
  });

  it("derives open fulfilment from so_line_balances", () => {
    expect(sql).toMatch(/so_line_balances/);
  });

  it("counts converted quotes as won", () => {
    expect(sql).toMatch(/'accepted','converted'/);
  });

  it("page does not bucket aging or sum receivables client-side", () => {
    const page = readFileSync(
      join(process.cwd(), "src", "pages", "sales", "SalesDashboard.tsx"),
      "utf8",
    );
    expect(page).not.toMatch(/bucketForDaysOverdue|customer_credit_balances|finance_ar_open_items/);
  });
});
