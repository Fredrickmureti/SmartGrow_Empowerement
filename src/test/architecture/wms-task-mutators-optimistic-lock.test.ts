/**
 * Architecture guard — every `wms_tasks` mutator carries an optimistic lock
 * (Warehouse Product/Inventory Consumer Audit, Phase 3).
 *
 * Regression this pins: `wms_split_putaway_task` and
 * `wms_reassign_putaway_task` originally took no expected version and read the
 * task with a plain `SELECT ... INTO` — so two supervisors splitting the same
 * task concurrently each validated their quantity against the same stale
 * `wms_tasks.quantity`, and a task could be split beyond what it held.
 *
 * The generated Supabase types file is the mirror of the live signature, so
 * asserting on it fails the moment a migration drops the parameter again.
 * Client callers are checked too — a server guard nobody feeds is inert.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * RPCs that mutate a `wms_tasks` row's business state (quantity, destination,
 * lifecycle state) and therefore MUST take an expected version.
 * Read-only RPCs (`wms_open_tasks_for_document`, `wms_task_telemetry`) and
 * lease keep-alives (`wms_task_heartbeat`, which only extends the caller's own
 * lease) are deliberately out of scope.
 */
const VERSIONED_TASK_MUTATORS: { rpc: string; param: string }[] = [
  { rpc: "wms_transition_task", param: "_expected_version" },
  { rpc: "wms_split_putaway_task", param: "p_row_version" },
  { rpc: "wms_reassign_putaway_task", param: "p_row_version" },
];

/** The `Args` block of an RPC entry in the generated types file. */
function rpcArgsBlock(types: string, rpc: string): string {
  const start = types.indexOf(`      ${rpc}: {`);
  if (start < 0) return "";
  const argsIdx = types.indexOf("Args:", start);
  const returnsIdx = types.indexOf("Returns:", argsIdx);
  if (argsIdx < 0 || returnsIdx < 0) return "";
  return types.slice(argsIdx, returnsIdx);
}

/** The argument object of a `supabase.rpc("<name>", { … })` / `enqueue` call. */
function callArgs(src: string, rpc: string): string {
  const start = src.indexOf(`"${rpc}"`);
  if (start < 0) return "";
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

describe("WMS task mutators are guarded by an optimistic lock", () => {
  const types = read("src/integrations/supabase/types.ts");

  it.each(VERSIONED_TASK_MUTATORS)("$rpc takes $param", ({ rpc, param }) => {
    const args = rpcArgsBlock(types, rpc);
    expect(args, `${rpc} not found in the generated types`).not.toBe("");
    expect(args).toContain(param);
  });

  it.each(VERSIONED_TASK_MUTATORS)("$rpc's version parameter is required", ({ rpc, param }) => {
    const args = rpcArgsBlock(types, rpc);
    // An optional (`param?:`) version is a silent opt-out of the lock.
    expect(args).not.toMatch(new RegExp(`${param}\\?\\s*:`));
  });

  it("the putaway action surface sends the rendered row_version", () => {
    const src = read("src/features/warehouse/putaway/PutawayTaskActions.tsx");
    for (const rpc of ["wms_reassign_putaway_task", "wms_split_putaway_task"]) {
      const args = callArgs(src, rpc);
      expect(args, `${rpc} call not found`).not.toBe("");
      expect(args).toContain("p_row_version: task.row_version");
    }
    // The version must come from the task the operator saw, not be re-read.
    expect(src).toContain("row_version: number");
  });

  it.each([
    "src/pages/warehouse/PutawayQueue.tsx",
    "src/pages/warehouse-mobile/MobilePutaway.tsx",
  ])("%s feeds row_version into PutawayTaskActions", (file) => {
    const src = read(file);
    expect(src).toContain("PutawayTaskActions");
    expect(src).toMatch(/row_version:\s*(t|task)\.row_version/);
    // …and actually selects it, otherwise it would always be undefined.
    expect(src).toMatch(/row_version/);
  });
});
