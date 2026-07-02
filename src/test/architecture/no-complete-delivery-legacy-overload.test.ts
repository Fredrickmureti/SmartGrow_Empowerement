/**
 * Round-4 guard: the legacy 4-arg `complete_delivery_atomic(uuid,uuid,text,jsonb)`
 * overload has been dropped. Every client call MUST pass `p_received_by_user_id`,
 * otherwise PostgREST will fail with "function does not exist" — but we want
 * the failure to surface at code-review time, not at runtime.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

describe("complete_delivery_atomic call sites", () => {
  it("every .rpc('complete_delivery_atomic', …) call passes p_received_by_user_id", () => {
    // Pull every multi-line .rpc call in src/.
    const raw = execSync(
      `grep -rn -A 6 "complete_delivery_atomic" src --include="*.ts" --include="*.tsx" || true`,
      { encoding: "utf8" }
    );

    // Group output by file:line then check each rpc() block contains the key.
    const blocks = raw.split(/^--$/m);
    const offenders: string[] = [];
    for (const block of blocks) {
      // Only consider blocks that actually invoke the RPC (not type defs / comments).
      if (!/\.rpc\(\s*["']complete_delivery_atomic["']/.test(block)) continue;
      if (!/p_received_by_user_id/.test(block)) {
        const firstLine = block.split("\n").find((l) => l.includes("complete_delivery_atomic")) ?? block.slice(0, 200);
        offenders.push(firstLine.trim());
      }
    }
    expect(offenders, `Missing p_received_by_user_id in: \n${offenders.join("\n")}`).toEqual([]);
  });
});
