/**
 * Architecture guard — Wave 3 · Phase 1 (POS Payment Engine)
 *
 * The payment-session lifecycle is a server-owned domain. The rules this
 * test enforces:
 *
 *   1. Only the resolver and dialog surface layers in `src/lib/pos/` and
 *      `src/components/pos/` may reference the payment-session RPCs by
 *      name. No feature module, hook, or page may `supabase.rpc(...)`
 *      into them directly — they must go through the dedicated client
 *      wrapper (`src/lib/pos/paymentSessionClient.ts`, added in a later
 *      slice of Phase 1). This keeps the FSM enforcement, idempotency,
 *      and business-event emission in one place.
 *
 *   2. The five session RPCs must always be called with a payload; a
 *      bare `supabase.rpc("pos_payment_session_*")` with no second arg
 *      would bypass idempotency + FSM guards.
 *
 * The test scans the shipped source tree. It intentionally fails the
 * build if a future edit re-scatters the payment domain across
 * components.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");

const SESSION_RPCS = [
  "pos_payment_session_open",
  "pos_payment_session_record_tender",
  "pos_payment_session_reverse_tender",
  "pos_payment_session_commit",
  "pos_payment_session_cancel",
] as const;

/** Files allowed to name the session RPCs. Anything else must go through the client wrapper. */
const ALLOWLIST = [
  /^lib[\\/]pos[\\/]paymentSessionClient\.ts$/,
  /^test[\\/]/,
  /^__tests__[\\/]/,
  /\.test\.ts$/,
  /\.test\.tsx$/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("POS payment-session lifecycle is server-owned", () => {
  const files = walk(ROOT);

  it("only the paymentSessionClient wrapper may call the session RPCs", () => {
    const offenders: Array<{ file: string; rpc: string }> = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (ALLOWLIST.some((r) => r.test(rel))) continue;
      const src = readFileSync(file, "utf8");
      for (const rpc of SESSION_RPCS) {
        if (src.includes(`"${rpc}"`) || src.includes(`'${rpc}'`)) {
          offenders.push({ file: rel, rpc });
        }
      }
    }
    expect(
      offenders,
      `Payment-session RPCs must be called via src/lib/pos/paymentSessionClient.ts.\nOffenders:\n${offenders
        .map((o) => `  ${o.file} → ${o.rpc}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
