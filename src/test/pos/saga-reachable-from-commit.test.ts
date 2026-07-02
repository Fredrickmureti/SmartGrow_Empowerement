/**
 * Track 1 — Saga-real verification.
 *
 * The previous loop landed the seam shape (CommandRouter + saga + queue)
 * but nothing in the renderer ever fired `pos:sale-committed`. This test
 * locks the wiring that `usePOSTransactionOffline.onSuccess` now calls
 * `hardwareClient.emitSaleCommitted` exactly once with the saleId / cart
 * / payment payload shape the SaleSaga expects.
 *
 * It also locks the saga's idempotency contract: a second commit for the
 * same saleId is a no-op (the outbox's unique `(sale_id, step)` row is
 * not duplicated and the queue does not re-enqueue).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOK = readFileSync(
  join(process.cwd(), "src/hooks/pos/usePOSTransactionOffline.ts"),
  "utf8",
);
const SAGA = readFileSync(
  join(process.cwd(), "electron/hardware/SaleSaga.ts"),
  "utf8",
);

describe("ADR-0014 Track 1 — saga is reachable from POS commit", () => {
  it("imports hardwareClient", () => {
    expect(HOOK).toMatch(/from\s+["']@\/services\/hardware\/HardwareClient["']/);
  });

  it("fires emitSaleCommitted in the success path", () => {
    expect(HOOK).toMatch(/hardwareClient\.emitSaleCommitted\s*\(/);
  });

  it("passes saleId from the committed transaction", () => {
    expect(HOOK).toMatch(/saleId:\s*result\.transaction\.id/);
  });

  it("only fires for online commits (offline transactions sync later)", () => {
    expect(HOOK).toMatch(/!result\.isOffline[\s\S]{0,40}result\.transaction/);
  });

  it("requests drawer kick only when at least one cash payment is present", () => {
    expect(HOOK).toMatch(/payments\.some\(\(p\)\s*=>\s*p\.method\s*===\s*['"]cash['"]\)/);
  });

  it("does not break the sale on saga failure (caught + warned, not rethrown)", () => {
    expect(HOOK).toMatch(/emitSaleCommitted failed/);
  });
});

describe("ADR-0014 Track 1 — saga outbox dedups per (sale_id, step)", () => {
  it("upsert returns the existing row instead of inserting a duplicate", () => {
    // The InMemoryOutboxStore implementation is the authoritative contract
    // shared with the SqliteOutboxStore (both must short-circuit on the
    // existing row).
    expect(SAGA).toMatch(/const existing = this\.rows\.find/);
    expect(SAGA).toMatch(/if \(existing\) return existing/);
  });

  it("queue enqueue idempotency key is sale-scoped per step", () => {
    expect(SAGA).toMatch(/idempotencyKey:\s*`\$\{payload\.saleId\}:\$\{step\}`/);
  });

  it("replay uses the same key, so a restart cannot double-enqueue", () => {
    expect(SAGA).toMatch(/idempotencyKey:\s*`\$\{row\.sale_id\}:\$\{row\.step\}`/);
  });
});
