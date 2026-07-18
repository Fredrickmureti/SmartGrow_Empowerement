/**
 * Phase 5 · Batch T9 architecture guard.
 *
 * Idempotency response cache:
 *   1. Latest migration creates `pos_transaction_idempotency` with RLS +
 *      SELECT grant to `authenticated` and a 24h `expires_at` default.
 *   2. `process_pos_transaction` reads the cache BEFORE the pessimistic
 *      lock and writes the full response BEFORE returning success.
 *   3. `cleanup_pos_transaction_idempotency()` exists as the TTL reaper.
 *   4. No client-side code writes to the cache table — only the RPC does.
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

describe("POS architecture guard — idempotency response cache (T9)", () => {
  it("creates pos_transaction_idempotency with RLS, grants and TTL default", () => {
    const file = latestFile("pos_transaction_idempotency");
    const sql = readFileSync(file, "utf8");
    expect(sql).toMatch(
      /CREATE TABLE\s+IF NOT EXISTS\s+public\.pos_transaction_idempotency/i,
    );
    expect(sql).toMatch(/idempotency_key\s+text\s+PRIMARY KEY/i);
    expect(sql).toMatch(/response\s+jsonb\s+NOT NULL/i);
    expect(sql).toMatch(/expires_at[\s\S]*interval\s+'24 hours'/i);
    expect(sql).toMatch(
      /GRANT SELECT ON public\.pos_transaction_idempotency TO authenticated/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE public\.pos_transaction_idempotency ENABLE ROW LEVEL SECURITY/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY[\s\S]*pos_transaction_idempotency[\s\S]*FOR SELECT/i,
    );
  });

  it("process_pos_transaction reads the cache before the advisory lock", () => {
    const file = latestFile("pos_transaction_idempotency");
    const sql = readFileSync(file, "utf8");
    const idxRead = sql.search(
      /FROM\s+public\.pos_transaction_idempotency\s+WHERE\s+idempotency_key/i,
    );
    const idxLock = sql.search(/pg_advisory_xact_lock\s*\(/);
    expect(idxRead).toBeGreaterThan(-1);
    expect(idxLock).toBeGreaterThan(-1);
    expect(idxRead).toBeLessThan(idxLock);
  });

  it("process_pos_transaction writes the response cache before RETURN", () => {
    const file = latestFile("pos_transaction_idempotency");
    const sql = readFileSync(file, "utf8");
    expect(sql).toMatch(
      /INSERT INTO\s+public\.pos_transaction_idempotency[\s\S]*ON CONFLICT\s*\(idempotency_key\)\s*DO NOTHING/i,
    );
    // The response variable must be captured, not returned inline, so the same
    // JSONB is what we cache and what we return.
    expect(sql).toMatch(/v_response\s*:=\s*jsonb_build_object\(/);
    expect(sql).toMatch(/RETURN\s+v_response\s*;/);
  });

  it("ships the TTL cleanup function", () => {
    const file = latestFile("pos_transaction_idempotency");
    const sql = readFileSync(file, "utf8");
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION\s+public\.cleanup_pos_transaction_idempotency/i,
    );
    expect(sql).toMatch(
      /DELETE FROM\s+public\.pos_transaction_idempotency[\s\S]*expires_at\s*<\s*now\(\)/i,
    );
  });

  it("no client-side code writes to pos_transaction_idempotency", () => {
    // Only the SQL migration and test files may reference the table.
    const hits = execSync(
      "rg -l pos_transaction_idempotency src --glob '!src/test/**' || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(hits).toEqual([]);
  });
});
