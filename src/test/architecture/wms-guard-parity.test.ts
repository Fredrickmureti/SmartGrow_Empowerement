/**
 * Meta-guard — Phase 2.4 §4.
 *
 * `wms-no-direct-domain-rpc.test.ts` bans a list of sanctioned domain
 * RPCs from `src/pages/warehouse/**`. That ban is only safe if every
 * banned RPC actually has a home in the typed wrapper layer — otherwise
 * the ban would simply make the operation unreachable.
 *
 * This guard pins the two families together: for each banned RPC there
 * must be exactly one call site in
 * `src/features/warehouse/aggregates/**`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { rpcCallSitesInWrapperLayer } from "./wmsGuardUtils";

const BAN_LIST_FILE = path.join(__dirname, "wms-no-direct-domain-rpc.test.ts");

/** Parse the FORBIDDEN_RPCS array out of the sibling guard. */
function bannedRpcs(): string[] {
  const src = readFileSync(BAN_LIST_FILE, "utf8");
  const block = /const FORBIDDEN_RPCS\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!block) throw new Error("Could not locate FORBIDDEN_RPCS in wms-no-direct-domain-rpc.test.ts");
  return [...block[1].matchAll(/["'`]([a-z0-9_]+)["'`]/g)].map((m) => m[1]);
}

describe("wms guard parity", () => {
  it("the ban list is non-empty and parseable", () => {
    expect(bannedRpcs().length).toBeGreaterThan(5);
  });

  it("every banned domain RPC has exactly one wrapper-layer call site", () => {
    const problems: string[] = [];
    for (const rpc of bannedRpcs()) {
      const n = rpcCallSitesInWrapperLayer(rpc);
      if (n !== 1) {
        problems.push(
          `${rpc}: ${n} call site(s) in src/features/warehouse/aggregates/** (expected exactly 1)`,
        );
      }
    }
    expect(
      problems,
      `Banned-from-pages RPCs must live in the typed wrapper layer:\n${problems.join("\n")}`,
    ).toEqual([]);
  });
});
