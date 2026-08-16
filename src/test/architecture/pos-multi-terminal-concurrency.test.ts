/**
 * Architecture guard — POS Wave Phase 8 (concurrency & idempotency).
 *
 * Held orders, split bills and table merge/transfer/move are multi-terminal
 * operations. This guard fails the build if any of them regress to
 * client-side money math, direct table writes, or unguarded mutations that
 * would let a second terminal silently clobber the first.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const migrationsDir = resolve(root, "supabase/migrations");
const sql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(resolve(migrationsDir, f), "utf8"))
  .join("\n");

const held = read("src/hooks/pos/usePOSHeldTransactions.ts");
const split = read("src/hooks/pos/useBillSplitting.ts");
const transfer = read("src/hooks/pos/useTableTransfer.ts");

const RPCS = [
  "hold_pos_transaction",
  "cancel_pos_held_transaction",
  "create_pos_split_bill",
  "assign_pos_split_item",
  "remove_pos_split_item",
  "pay_pos_split_portion",
  "cancel_pos_split_bill",
  "move_pos_table_session",
];

describe("POS Phase 8 — multi-terminal concurrency", () => {
  it("every Phase 8 RPC exists and is locked down", () => {
    for (const fn of RPCS) {
      expect(sql, `${fn} must be defined`).toContain(`FUNCTION public.${fn}(`);
      expect(sql, `${fn} must be revoked from PUBLIC/anon`).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon`),
      );
      expect(sql, `${fn} must grant EXECUTE to authenticated`).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`),
      );
    }
  });

  it("hold re-prices the basket with pos_quote_cart on the server", () => {
    const body = sql.slice(sql.indexOf("FUNCTION public.hold_pos_transaction("));
    expect(body.slice(0, 6000)).toContain("pos_quote_cart");
  });

  it("held-order client never inserts or updates the held table directly", () => {
    expect(held).not.toMatch(/from\(\s*["']pos_held_transactions["']\s*\)[\s\S]{0,200}?\.(insert|update|delete)\(/);
    expect(held).toContain("hold_pos_transaction");
    expect(held).toContain("cancel_pos_held_transaction");
    expect(held).toContain("recall_pos_held_transaction");
  });

  it("split-bill client never writes split tables and does no money math", () => {
    for (const table of ["pos_split_bills", "pos_split_bill_portions", "pos_split_bill_items"]) {
      expect(split).not.toMatch(
        new RegExp(`from\\(\\s*["']${table}["']\\s*\\)[\\s\\S]{0,200}?\\.(insert|update|delete)\\(`),
      );
    }
    expect(split).not.toContain("calculateEqualSplit");
    expect(split).not.toMatch(/totalAmount\s*\/\s*splitCount/);
  });

  it("a portion can only be paid once (server conflict, not clobber)", () => {
    const body = sql.slice(sql.indexOf("FUNCTION public.pay_pos_split_portion("));
    const fn = body.slice(0, 4000);
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain("portion_already_paid");
    expect(fn).toContain("'conflict', true");
  });

  it("merge/transfer/move are version-guarded and business+branch checked", () => {
    for (const fn of ["merge_table_orders", "transfer_table_items", "move_pos_table_session"]) {
      const body = sql.slice(sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`)).slice(0, 9000);
      expect(body, `${fn} must expose an expected-version guard`).toMatch(/p_expected_\w*version/);
      expect(body, `${fn} must return a conflict`).toContain("'conflict', true");
      expect(body, `${fn} must check business access`).toContain("user_can_access_business");
      expect(body, `${fn} must check branch access`).toContain("assert_pos_caller_branch_access");
    }
  });

  it("transfer/merge audit rows carry business_id (NOT NULL column)", () => {
    const merge = sql.slice(sql.lastIndexOf("FUNCTION public.merge_table_orders(")).slice(0, 9000);
    expect(merge).toMatch(/INSERT INTO public\.pos_table_transfers[\s\S]{0,200}business_id/);
  });

  it("the ambiguous transfer_table_items overload is dropped", () => {
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.transfer_table_items(uuid, uuid, uuid, jsonb, uuid, text)");
  });

  it("transfer client routes through RPCs only", () => {
    expect(transfer).not.toMatch(/from\(\s*["']pos_table_(transfers|sessions)["']\s*\)[\s\S]{0,200}?\.(insert|update|delete)\(/);
    expect(transfer).toContain("move_pos_table_session");
  });

  it("client write privileges on split/transfer tables are revoked", () => {
    for (const table of [
      "pos_split_bills",
      "pos_split_bill_portions",
      "pos_split_bill_items",
      "pos_table_transfers",
      "pos_transfer_items",
    ]) {
      expect(sql).toContain(`REVOKE INSERT, UPDATE, DELETE ON public.${table} FROM authenticated`);
      expect(sql).toContain(`GRANT SELECT ON public.${table} TO authenticated`);
    }
  });
});
