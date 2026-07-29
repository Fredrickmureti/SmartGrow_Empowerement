import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 2.4 §3 guard.
 *
 * Pages in `src/pages/warehouse/**` must not import the sanctioned WMS
 * domain RPCs directly via `supabase.rpc("<name>", …)`. They MUST go
 * through the typed wrappers in
 * `src/features/warehouse/aggregates/useDomainOperations.ts` (or the
 * FSM-only wrappers in `useAggregateTransitions.ts`).
 *
 * This preserves optimistic-lock handling, invalidation semantics, and
 * "someone else just updated this" toast copy across the whole app.
 */
const FORBIDDEN_RPCS = [
  "create_pick_wave",
  "release_pick_wave",
  "complete_pick_task",
  "seal_pack_carton",
  "load_carton_onto_manifest",
  "dispatch_loading_manifest",
  "post_count_session",
  "accept_qc_inspection",
  "reject_qc_inspection",
  "cancel_qc_inspection",
];

const ROOT = join(process.cwd(), "src/pages/warehouse");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

describe("wms-no-direct-domain-rpc", () => {
  it("no page in src/pages/warehouse imports sanctioned WMS domain RPCs directly", () => {
    const files = walk(ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      for (const rpc of FORBIDDEN_RPCS) {
        const re = new RegExp(`supabase\\.rpc\\(\\s*["'\`]${rpc}["'\`]`);
        if (re.test(src)) violations.push(`${file} → ${rpc}`);
      }
    }
    expect(violations, `Route these through useDomainOperations.ts:\n${violations.join("\n")}`).toEqual([]);
  });
});
