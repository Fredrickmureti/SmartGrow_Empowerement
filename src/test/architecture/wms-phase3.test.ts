/**
 * Architecture guard — WMS Phase 3 (Picking → Packing).
 *
 * Phase 3 introduces four RPCs that MUST own the write side of the
 * pick-wave lifecycle:
 *
 *   • create_pick_wave / release_pick_wave — the only sanctioned way
 *     to seed pick tasks and reserve stock for a wave.
 *   • complete_pick_task — records picked qty, rolls up the wave line,
 *     advances wave state, emits `warehouse.pick.completed`.
 *   • complete_pack_task — closes the wave, mints the shipment LPN,
 *     emits `warehouse.pack.completed`.
 *
 * Client code that bypasses these RPCs breaks the reservation/rollup
 * invariants and the outbox — reject at CI time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const SELF = __filename;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("wms phase 3 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("no client code inserts pick or pack tasks directly", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (
        /from\(\s*["']wms_tasks["']\s*\)/.test(src) &&
        /\.insert\s*\(\s*[\s\S]{0,400}?task_type\s*:\s*["'](pick|pack)["']/.test(src)
      ) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Seed pick/pack tasks via supabase.rpc("release_pick_wave" / "complete_pack_task", ...) — never .insert({task_type:"pick"|"pack"}):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no client code writes wave state directly (must use sanctioned RPCs)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (
        /from\(\s*["']wms_pick_waves["']\s*\)/.test(src) &&
        /\.update\s*\(\s*\{[^}]*state\s*:/s.test(src)
      ) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Advance wave state via release_pick_wave / complete_pick_task / complete_pack_task — never direct .update({state:...}):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // Phase 2.4 §4 — layering changed: pages call typed hooks, the wrapper
  // layer owns the single RPC call site. The invariant ("this RPC is the
  // only write path") is unchanged; only the caller moved.
  it("create_pick_wave / release_pick_wave are owned by the wrapper layer and consumed by WavePlanner", () => {
    const a = checkRpcOwnership("WavePlanner.tsx", "useCreateAndReleaseWave", "create_pick_wave");
    const b = checkRpcOwnership("WavePlanner.tsx", "useCreateAndReleaseWave", "release_pick_wave");
    expect([a, b].filter(Boolean).join("\n")).toBe("");
  });

  it("complete_pick_task is owned by the wrapper layer and consumed by PickList", () => {
    expect(checkRpcOwnership("PickList.tsx", "useCompletePickTask", "complete_pick_task")).toBe("");
  });

  it("PackStation calls complete_pack_task", () => {
    // Not on the domain-RPC ban list — PackStation still owns this call site.
    expect(pageCallsRpc("PackStation.tsx", "complete_pack_task")).toBe(true);
  });
});

