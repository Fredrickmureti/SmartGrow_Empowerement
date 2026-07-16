/**
 * ADR 0066 architecture guard.
 *
 * The two outbound RPCs that replicate line data or emit stock movements
 * MUST forward `lot_number` and `serial_number`. If a future refactor drops
 * either column from the propagation path, downstream recall
 * (`v_lot_downstream_consumption`) silently loses coverage.
 *
 * This guard reads the migration SQL directly so it fails deterministically
 * regardless of DB connectivity.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

function readMigration(prefix: string): string {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!file) throw new Error(`Migration ${prefix} not found`);
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

describe("ADR 0066 — downstream lot stamping propagation", () => {
  const sql = readMigration("20260716215210");

  it("approve_sales_return_atomic copies lot_number/serial_number into credit_note_items", () => {
    const cnInsert = /INSERT INTO public\.credit_note_items[\s\S]*?FROM public\.sales_return_items/i;
    const block = sql.match(cnInsert)?.[0] ?? "";
    expect(block).toMatch(/lot_number/);
    expect(block).toMatch(/serial_number/);
  });

  it("approve_sales_return_atomic forwards lot_number/serial_number to stock_movements", () => {
    const smInsert =
      /INSERT INTO public\.stock_movements\([\s\S]*?VALUES[\s\S]*?v_item\.serial_number/i;
    expect(sql).toMatch(smInsert);
  });

  it("confirm_invoice_atomic forwards lot_number/serial_number into auto delivery_note_items", () => {
    const dnInsert =
      /INSERT INTO public\.delivery_note_items[\s\S]*?FROM public\.invoice_items ii/i;
    const block = sql.match(dnInsert)?.[0] ?? "";
    expect(block).toMatch(/ii\.lot_number/);
    expect(block).toMatch(/ii\.serial_number/);
  });

  it("enforcement trigger is installed on invoices, credit_notes, sales_returns", () => {
    for (const t of ["invoices", "credit_notes", "sales_returns"]) {
      const re = new RegExp(
        `CREATE TRIGGER trg_enforce_lot_stamping[\\s\\S]*?ON public\\.${t}\\b`,
        "i",
      );
      expect(sql).toMatch(re);
    }
  });
});