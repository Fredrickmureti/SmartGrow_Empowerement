/**
 * Architecture guard — 3PL billing invoice contract (Phase 1).
 *
 * `generate_3pl_invoice` shipped twice writing columns that do not exist
 * (`invoice_items.subtotal` / `invoice_items.total`) and omitting a
 * NOT NULL column (`invoices.business_id`). Both are 100% runtime
 * failures that no test caught, because nothing compared the RPC's
 * INSERT column list against the real schema.
 *
 * This guard closes the class: every column the billing RPCs write must
 * exist on that table in the generated Supabase types, and the invoice
 * must be numbered through the canonical `generate_invoice_number` RPC.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

/** Newest migration whose body defines generate_3pl_invoice. */
function billingRpcSql(): string {
  const dir = path.join(ROOT, "supabase/migrations");
  const hits = readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .filter((n) => {
      const p = path.join(dir, n);
      return (
        statSync(p).isFile() &&
        readFileSync(p, "utf8").includes("FUNCTION public.generate_3pl_invoice")
      );
    });
  expect(hits.length, "no migration defines generate_3pl_invoice").toBeGreaterThan(0);
  return readFileSync(path.join(dir, hits[hits.length - 1]), "utf8");
}

/** Column names on a table, read from the generated Row type. */
function typedColumns(table: string): string[] {
  const src = readFileSync(
    path.join(ROOT, "src/integrations/supabase/types.ts"),
    "utf8",
  );
  const start = src.indexOf(`      ${table}: {\n        Row: {`);
  expect(start, `table ${table} not found in generated types`).toBeGreaterThan(-1);
  const rowStart = src.indexOf("Row: {", start) + "Row: {".length;
  const rowEnd = src.indexOf("\n        }", rowStart);
  return [...src.slice(rowStart, rowEnd).matchAll(/^\s{10}([a-z0-9_]+)\??:/gim)].map(
    (m) => m[1],
  );
}

/** Every `INSERT INTO public.<table> ( cols )` in the SQL. */
function insertTargets(sql: string): { table: string; columns: string[] }[] {
  const out: { table: string; columns: string[] }[] = [];
  const re = /INSERT INTO public\.([a-z0-9_]+)\s*\(([^)]*)\)/gi;
  for (const m of sql.matchAll(re)) {
    const columns = m[2]
      .split(",")
      .map((c) => c.replace(/--.*$/gm, "").trim())
      .filter((c) => /^[a-z0-9_]+$/i.test(c));
    if (columns.length > 0) out.push({ table: m[1], columns });
  }
  return out;
}

describe("3PL billing invoice contract", () => {
  const sql = billingRpcSql();

  it("every column the billing migration inserts exists on its table", () => {
    const bad: string[] = [];
    for (const { table, columns } of insertTargets(sql)) {
      const known = typedColumns(table);
      for (const col of columns) {
        if (!known.includes(col)) bad.push(`${table}.${col}`);
      }
    }
    expect(bad, `columns written but absent from the schema: ${bad.join(", ")}`).toEqual([]);
  });

  it("the invoice shell sets the NOT NULL scoping columns", () => {
    const invoiceInsert = insertTargets(sql).find((t) => t.table === "invoices");
    expect(invoiceInsert, "generate_3pl_invoice does not insert into invoices").toBeTruthy();
    for (const required of ["organization_id", "business_id", "contact_id", "invoice_number"]) {
      expect(invoiceInsert!.columns).toContain(required);
    }
  });

  it("invoice numbering goes through the canonical RPC", () => {
    expect(sql).toContain("public.generate_invoice_number(");
    // The old hand-rolled '3PL-YYYYMM-<client>' number collided on the
    // (organization_id, invoice_number) unique index for any second run.
    expect(sql).not.toMatch(/'3PL-'\s*\|\|\s*to_char/);
  });

  it("the AR party is mandatory, resolved from the billing client", () => {
    expect(sql).toContain("wms_billing_clients");
    expect(sql).toMatch(/has no AR contact/);
  });

  it("mixed-currency periods raise instead of silently dropping rows", () => {
    expect(sql).toMatch(/more than one currency/);
    expect(sql).not.toMatch(/COALESCE\(currency, v_currency\) = v_currency/);
  });

  it("tax is applied from the contact's default tax rate", () => {
    expect(sql).toContain("default_tax_rate_id");
    expect(sql).toMatch(/tax_amount\s*=/);
  });
});
