/**
 * Phase 3 · Batch T2 architecture guard (ADR 0082 D3).
 *
 * Idempotency is mandatory end-to-end:
 *
 *   1. The latest migration installs the
 *      `tg_pos_transactions_require_idempotency_key` trigger, which raises
 *      `not_null_violation` on any insert without a key.
 *   2. `usePOSTransactionOffline.ts` no longer falls back to
 *      `crypto.randomUUID()` — it throws if `data.idempotency_key` is
 *      absent so the bug surfaces at the boundary.
 *   3. `TransactionQueue.ts` exposes `recoverStuckSyncing()` and calls
 *      it from `syncAll()` so a crashed tab cannot leave a queued
 *      transaction wedged in `syncing`.
 *   4. The ESLint rule `local/no-pos-commit-without-idempotency-key`
 *      is registered and enabled.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function latestFile(pattern: string): string {
  const out = execSync(`rg -l ${JSON.stringify(pattern)} supabase/migrations`, {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
  const last = out[out.length - 1];
  if (!last) throw new Error(`no migration matches ${pattern}`);
  return last;
}

describe("POS architecture guard — mandatory idempotency (T2)", () => {
  it("installs the require-idempotency trigger on pos_transactions", () => {
    const file = latestFile("tg_pos_transactions_require_idempotency_key");
    const sql = readFileSync(file, "utf8");
    expect(sql).toMatch(
      /CREATE TRIGGER trg_pos_transactions_require_idempotency_key[\s\S]*BEFORE INSERT[\s\S]*pos_transactions/,
    );
    expect(sql).toMatch(/idempotency_key IS NULL/);
    expect(sql).toMatch(/not_null_violation/);
  });

  it("usePOSTransactionOffline throws instead of falling back to randomUUID", () => {
    const src = readFileSync("src/hooks/pos/usePOSTransactionOffline.ts", "utf8");
    expect(src).not.toMatch(
      /p_idempotency_key\s*:\s*data\.idempotency_key\s*\|\|\s*crypto\.randomUUID\(\)/,
    );
    // The new implementation raises when the key is missing.
    expect(src).toMatch(/POS commit missing idempotency_key/);
  });

  it("TransactionQueue exposes crash-recovery for stuck syncing rows", () => {
    const src = readFileSync("src/services/offline/TransactionQueue.ts", "utf8");
    expect(src).toMatch(/recoverStuckSyncing\s*\(/);
    // syncAll must call it before draining.
    expect(src).toMatch(/this\.recoverStuckSyncing\(\)/);
    // Wave 3 · Phase 4.b — replay routes through the payment-session
    // wrapper. `queued.id` is the base idempotency key on both
    // openSession and every derived tender key, so retries collapse.
    expect(src).toMatch(/idempotencyKey:\s*queued\.id/);
    expect(src).toMatch(/\$\{queued\.id\}:tender:\$\{i\}/);
  });

  it("registers and enables the no-pos-commit-without-idempotency-key ESLint rule", () => {
    const cfg = readFileSync("eslint.config.js", "utf8");
    expect(cfg).toMatch(/no-pos-commit-without-idempotency-key/);
    expect(cfg).toMatch(
      /"local\/no-pos-commit-without-idempotency-key"\s*:\s*"error"/,
    );
  });
});
