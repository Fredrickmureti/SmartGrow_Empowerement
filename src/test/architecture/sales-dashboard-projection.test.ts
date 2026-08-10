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

/**
 * Enum-literal ratchet.
 *
 * `invoices.status`, `estimates.status` and `credit_notes.status` are Postgres
 * enums. Comparing them against a label that does not exist raises 22P02 at
 * plan time, which PostgREST returns as HTTP 400 — the whole dashboard fails,
 * even when the table is empty. This is the exact defect that broke Sales
 * Overview (`credit_notes.status NOT IN ('draft','void','voided','cancelled')`
 * — `credit_note_status` has neither `voided` nor `cancelled`).
 */
const ENUM_LABELS: Record<string, string[]> = {
  invoices: ["draft", "sent", "viewed", "partial", "paid", "overdue", "cancelled", "confirmed", "voided"],
  estimates: ["draft", "sent", "viewed", "accepted", "rejected", "expired", "converted"],
  credit_notes: ["draft", "issued", "applied", "void", "refunded"],
};

/** Aliases the dashboard SQL binds to each enum-backed table. */
const TABLE_ALIASES: Record<string, string[]> = {
  invoices: ["", "i."],
  estimates: ["", "e."],
  credit_notes: ["", "n.", "cn."],
};

function statusLiterals(sql: string, prefixes: string[]): string[] {
  const found: string[] = [];
  for (const prefix of prefixes) {
    const escaped = prefix.replace(".", "\\.");
    const re = new RegExp(`${escaped}status\\s*(?:NOT\\s+)?IN\\s*\\(([^)]*)\\)|${escaped}status\\s*(?:<>|=)\\s*'([^']+)'`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      if (m[2]) found.push(m[2]);
      else for (const lit of m[1].matchAll(/'([^']*)'/g)) found.push(lit[1]);
    }
  }
  return found;
}

describe("sales dashboard only compares enum status columns to real labels", () => {
  const sql = latestDashboardFunctionSql();

  for (const [table, labels] of Object.entries(ENUM_LABELS)) {
    it(`uses only valid ${table}.status labels`, () => {
      // Slice the SQL to statements that mention the table so aliasless
      // `status IN (...)` predicates are attributed to the right enum.
      const blocks = sql
        .split(";")
        .filter((stmt) => new RegExp(`public\\.${table}\\b`).test(stmt));
      const used = new Set(blocks.flatMap((b) => statusLiterals(b, TABLE_ALIASES[table])));
      const invalid = [...used].filter((label) => label !== "" && !labels.includes(label));
      expect(invalid, `invalid ${table}.status literal(s)`).toEqual([]);
    });
  }
});
