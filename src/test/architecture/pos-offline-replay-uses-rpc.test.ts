/**
 * Architecture guard — Wave 2 · Phase C-3.
 *
 * The Electron/SQLite offline replay path (SQLiteSyncManager) MUST route
 * queued sales through `process_pos_transaction`, which delegates payment
 * writes to `_pos_record_payment`. Direct client-side inserts into
 * `pos_transaction_payments` (or `pos_transactions` / `pos_transaction_items`)
 * bypass the card FSM guard, catalog validator, GL posting trigger, stock
 * consumption, and idempotency collapse — the same failure modes the
 * server-side architecture guard locks out of the RPCs themselves.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILE = "src/services/offline/SQLiteSyncManager.ts";

describe("POS offline replay — must use process_pos_transaction RPC", () => {
  const src = readFileSync(FILE, "utf8");

  it("does not .insert() into pos_transaction_payments", () => {
    // Match: supabase.from('pos_transaction_payments') ... .insert(
    const re = /from\(\s*['"]pos_transaction_payments['"]\s*\)[\s\S]{0,200}?\.insert\(/;
    expect(src).not.toMatch(re);
  });

  it("does not .insert() into pos_transaction_items", () => {
    const re = /from\(\s*['"]pos_transaction_items['"]\s*\)[\s\S]{0,200}?\.insert\(/;
    expect(src).not.toMatch(re);
  });

  it("does not .insert() into pos_transactions", () => {
    const re = /from\(\s*['"]pos_transactions['"]\s*\)[\s\S]{0,200}?\.insert\(/;
    expect(src).not.toMatch(re);
  });

  it("invokes process_pos_transaction with an idempotency key", () => {
    expect(src).toMatch(/process_pos_transaction/);
    expect(src).toMatch(/p_idempotency_key\s*:/);
  });
});
