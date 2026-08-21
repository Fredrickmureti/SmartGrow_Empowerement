/**
 * FX tenant isolation (ADR 0136 / 0138) — client-side half of the ratchet.
 *
 * The database half lives in `supabase/tests/fx_tenant_isolation_test.sql`:
 * engine-internal FX resolvers are revoked from the Data API, and every FX
 * function still exposed to signed-in users authorises per business.
 *
 * This test stops the app from re-opening that hole from the other side, by
 * calling a revoked internal resolver over RPC (which would only fail at
 * runtime, in a tenant's face) instead of the guarded tenant-facing surface.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "../../..");

/** Engine internals: reachable only from other SECURITY DEFINER functions. */
const INTERNAL_FX_RPCS = [
  "resolve_exchange_rate",
  "require_exchange_rate",
  "resolve_sales_exchange_rate",
  "fx_stamp_document",
  "_pick_exchange_rate_row",
  "reverse_fx_revaluation_run",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("FX tenant isolation", () => {
  const files = walk(join(ROOT, "src")).filter(
    (f) => !f.includes("/test/") && !f.includes("__tests__"),
  );

  it("no client code invokes an engine-internal FX resolver over RPC", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const fn of INTERNAL_FX_RPCS) {
        // Only a real RPC invocation counts — prose references are fine.
        const rpc = new RegExp(`\\.rpc\\(\\s*["'\`]${fn}["'\`]`);
        if (rpc.test(src)) offenders.push(`${file.replace(ROOT + "/", "")} → ${fn}`);
      }
    }
    expect(offenders, `Use describe_exchange_rate instead:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the rate panel reads rates through the permission-checked describe RPC", () => {
    const panel = readFileSync(
      join(ROOT, "src/components/finance/ExchangeRatePanel.tsx"),
      "utf8",
    );
    expect(panel).toMatch(/\.rpc\(\s*["'`]describe_exchange_rate["'`]/);
  });

  it("keeps the database-side isolation ratchet on disk", () => {
    const sql = readFileSync(
      join(ROOT, "supabase/tests/fx_tenant_isolation_test.sql"),
      "utf8",
    );
    expect(sql).toMatch(/has_function_privilege\('authenticated'/);
    expect(sql).toMatch(/reverse_fx_revaluation_run must authorise against _run\.business_id/);
  });
});
