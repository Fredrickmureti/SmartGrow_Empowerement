/**
 * Architecture guard — POS Transaction Engine Batch T7.
 *
 * Downstream consumers (finance, inventory, analytics, CRM) depend on
 * two outbox topics and five governance duties being registered.
 * These are DB-level contracts; this static test asserts the migration
 * that ships them is present in the tree so a rebase can't silently
 * drop the wiring.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

function allMigrationsText(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");
}

describe("POS Transaction Engine — T7 outbox + governance", () => {
  const sql = allMigrationsText();

  it("registers the pos.sale.committed topic", () => {
    expect(sql).toMatch(/pos\.sale\.committed/);
    expect(sql).toMatch(/trg_pos_transaction_emit_event/);
  });

  it("registers the inventory.movement.recorded topic", () => {
    expect(sql).toMatch(/inventory\.movement\.recorded/);
    expect(sql).toMatch(/trg_stock_movement_emit_event/);
  });

  it("both outbox emitters use deterministic idempotency keys", () => {
    expect(sql).toMatch(/pos\.sale\.committed:'\s*\|\|/);
    expect(sql).toMatch(/inventory\.movement\.recorded:'\s*\|\|/);
  });

  it("registers the five POS governance duties", () => {
    for (const duty of [
      "pos.commit",
      "pos.void",
      "pos.return",
      "pos.override_price",
      "pos.override_discount",
    ]) {
      expect(sql).toContain(`'${duty}'`);
    }
  });
});