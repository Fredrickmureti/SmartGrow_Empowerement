/**
 * ADR 0067 architecture guard.
 *
 * Pins the serialised-inventory contract to the migration SQL so a future
 * refactor can't silently drop the movement trigger, the products flag, or
 * the extension of the downstream posting guard to serials.
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

describe("ADR 0067 — serialised inventory", () => {
  const sql = readMigration("20260716215647");

  it("adds is_serial_tracked to products with default false", () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.products[\s\S]*?is_serial_tracked boolean NOT NULL DEFAULT false/i,
    );
  });

  it("creates stock_serials with RLS + business/branch scoped policies", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.stock_serials/i);
    expect(sql).toMatch(/ALTER TABLE public\.stock_serials ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/CREATE POLICY stock_serials_select/i);
    expect(sql).toMatch(/CREATE POLICY stock_serials_write/i);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.stock_serials TO authenticated/i);
    expect(sql).toMatch(/GRANT ALL ON public\.stock_serials TO service_role/i);
  });

  it("installs movement-level enforcement trigger on stock_movements", () => {
    expect(sql).toMatch(
      /CREATE TRIGGER trg_enforce_serial_on_movement[\s\S]*?ON public\.stock_movements/i,
    );
    expect(sql).toMatch(/serial_number is required for stock_movements/i);
  });

  it("extends downstream posting guard to reject missing serial_number", () => {
    expect(sql).toMatch(/is_serial_tracked, false\) = true/i);
    expect(sql).toMatch(/ADR-0067:/);
  });
});