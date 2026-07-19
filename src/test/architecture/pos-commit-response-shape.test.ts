/**
 * S2 — TypeScript wire contract guard for the POS commit response.
 *
 * The DB-side guard `no-client-pos-money-math.test.ts` pins the SQL
 * response shape. This test pins the TypeScript-side counterpart so a
 * refactor of `paymentSessionClient.ts` cannot silently drop the
 * server-authoritative reconciliation fields the online commit hook
 * relies on (`serverTotals`, `totalMatchesServer` surfaced from
 * `usePOSTransactionOffline`).
 *
 * Complements ADR 0082 D1 (server-authoritative money math): the client
 * NEVER trusts its own cart total after commit; the row and the receipt
 * snapshot are the source of truth. This test just makes that structural.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("POS commit response — TS wire contract", () => {
  const clientPath = resolve(
    process.cwd(),
    "src/lib/pos/paymentSessionClient.ts",
  );
  const source = readFileSync(clientPath, "utf8");

  it("CommitSessionResult declares a server_totals field", () => {
    expect(source).toMatch(/server_totals\??:/);
  });

  it("CommitSessionResult declares a total_matches_server flag", () => {
    expect(source).toMatch(/total_matches_server\??:/);
  });

  it("commit RPC caller returns the raw envelope, without stripping fields", () => {
    // Guardrail: the wrapper must not remap the RPC response before
    // handing it to the caller — otherwise `server_totals` and
    // `total_matches_server` disappear from the reachable surface.
    expect(source).toMatch(
      /export async function commitSession[\s\S]*return data as unknown as CommitSessionResult;/,
    );
  });
});
