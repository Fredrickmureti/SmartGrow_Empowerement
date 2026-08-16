/**
 * Architecture guard — Wave 2 · Phase C-3, refreshed in Wave 3 · Phase 9.
 *
 * The Electron/SQLite offline replay path (SQLiteSyncManager) MUST route
 * queued sales through the server-owned payment-session saga
 * (`openSession → recordTender → commitSession`, which in turn calls
 * `process_pos_transaction` inside `pos_payment_session_commit`). Direct
 * client-side inserts into `pos_transaction_payments` (or `pos_transactions` /
 * `pos_transaction_items`) bypass the card FSM guard, catalog validator, GL
 * posting trigger, stock consumption, and idempotency collapse — the same
 * failure modes the server-side architecture guard locks out of the RPCs
 * themselves.
 *
 * Replay is only safe because every saga step carries a deterministic
 * idempotency key derived from the local transaction id, so a retry after a
 * partial failure collapses onto the same session and the same sale.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILE = "src/services/offline/SQLiteSyncManager.ts";

describe("POS offline replay — must use the server payment-session saga", () => {
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

  it("commits through the payment session, never a bare transaction RPC", () => {
    expect(src).toMatch(/openPaymentSession\(/);
    expect(src).toMatch(/recordPaymentTender\(/);
    expect(src).toMatch(/commitPaymentSession\(/);
    expect(src).not.toMatch(/rpc\(\s*['"]process_pos_transaction['"]/);
  });

  it("derives deterministic idempotency keys from the local transaction id", () => {
    expect(src).toMatch(/idempotencyKey:\s*tx\.id/);
    expect(src).toMatch(/idempotencyKey:\s*`\$\{tx\.id\}:tender:/);
  });
});

