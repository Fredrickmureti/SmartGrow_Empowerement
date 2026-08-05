/**
 * ADR-0110 Phase 6 guard — the legacy resolvers are gone.
 *
 * `pos_resolve_barcode` and `resolve_barcode_v2` were dropped from the
 * database. Every non-POS surface resolves through
 * `resolve_product_identity`; POS goes through `pos_resolve_scan`, which
 * delegates to the same resolver. A new caller of a dropped RPC would
 * fail at runtime with a 404 from PostgREST, so fail it at test time.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "../../");
const DROPPED = ["pos_resolve_barcode", "resolve_barcode_v2"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe("no client caller of a dropped identity RPC", () => {
  const files = walk(SRC).filter((f) => !f.includes("/integrations/supabase/types.ts"));

  for (const rpc of DROPPED) {
    it(`nothing calls supabase.rpc("${rpc}")`, () => {
      const offenders = files.filter((f) => {
        const src = readFileSync(f, "utf-8");
        return new RegExp(`rpc\\(\\s*["'\`]${rpc}["'\`]`).test(src);
      });
      expect(offenders.map((f) => f.replace(SRC, "src"))).toEqual([]);
    });
  }
});
