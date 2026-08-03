/**
 * Architecture guard — Yard & Trailer Management (ADR 0086, supersedes
 * the Phase 9 Yard Board guard).
 *
 * Invariants:
 * - `wms_trailer_visits` and `wms_yard_moves` are RPC-only. No client
 *   code may insert/update/delete them.
 * - The UI never calls the raw `check_in_trailer` / `depart_trailer`
 *   primitives — every arrival and exit goes through `gate_check_in` /
 *   `gate_exit` so the chain of custody in `wms_gate_events` is complete.
 * - Yard master-data writes (`wms_yard_slots`, `wms_trailers`) are
 *   funnelled through the single feature data layer `useYard.ts`.
 * - The yard data layer exposes the full transition set.
 * - Nav + routes wire the control tower, gate console and register.
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

const YARD_HOOKS = path.join(SRC, "features/warehouse/yard/useYard.ts");

describe("yard architecture (ADR 0086)", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("no client code writes to wms_trailer_visits or wms_yard_moves (RPC-only)", () => {
    const offenders: string[] = [];
    const banned =
      /from\(\s*["'](wms_trailer_visits|wms_yard_moves)["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    for (const f of files) {
      if (banned.test(readFileSync(f, "utf8"))) offenders.push(path.relative(SRC, f));
    }
    expect(
      offenders,
      `Use the gate/yard RPCs instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the UI never calls the raw check_in_trailer / depart_trailer primitives", () => {
    const offenders: string[] = [];
    const raw = /rpc\s*\)?\s*\(\s*["'](check_in_trailer|depart_trailer)["']/;
    for (const f of files) {
      if (raw.test(readFileSync(f, "utf8"))) offenders.push(path.relative(SRC, f));
    }
    expect(
      offenders,
      `Arrivals and exits must go through gate_check_in / gate_exit:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("yard master-data writes originate only from the yard data layer", () => {
    const offenders: string[] = [];
    const write = /from\(\s*["'](wms_yard_slots|wms_trailers)["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    for (const f of files) {
      if (f === YARD_HOOKS) continue;
      if (write.test(readFileSync(f, "utf8"))) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it("the yard data layer exposes the full transition set", () => {
    const src = readFileSync(YARD_HOOKS, "utf8");
    for (const rpc of [
      "gate_check_in",
      "gate_approve",
      "relocate_trailer",
      "assign_trailer_to_dock",
      "release_trailer_from_dock",
      "approve_trailer_departure",
      "gate_exit",
      "mark_trailer_no_show",
      "trailer_departure_blockers",
    ]) {
      expect(src, `useYard is missing ${rpc}`).toContain(rpc);
    }
  });

  it("nav and routes wire the yard surfaces", () => {
    const nav = readFileSync(path.join(SRC, "apps/warehouse/nav.ts"), "utf8");
    const routes = readFileSync(path.join(SRC, "apps/warehouse/routes.tsx"), "utf8");
    expect(nav).toContain("/warehouse-app/yard");
    expect(nav).toContain("/warehouse-app/yard/gate");
    expect(nav).toContain("/warehouse-app/yard/trailers");
    expect(/path="yard"/.test(routes)).toBe(true);
    expect(/path="yard\/gate"/.test(routes)).toBe(true);
    expect(/path="yard\/trailers"/.test(routes)).toBe(true);
  });

  it("realtime subscribes the yard tables", () => {
    const sync = readFileSync(path.join(SRC, "features/warehouse/realtime/useWmsRealtimeSync.ts"), "utf8");
    expect(sync).toContain("wms_trailers:");
    expect(sync).toContain("wms_yard_moves:");
    expect(sync).toContain('["wms-yard-moves"]');
  });

  /* ---------------------------------------------------------------- */
  /* Phase 5 — jockey work orders                                      */
  /* ---------------------------------------------------------------- */

  it("yard move work orders go through the RPCs, never a direct wms_tasks write", () => {
    const offenders: string[] = [];
    for (const f of walk(path.join(SRC, "features/warehouse/yard"))
      .concat(walk(path.join(SRC, "pages/warehouse")).filter((f) => /Yard|Gate|Trailer/.test(f)))) {
      const src = readFileSync(f, "utf8");
      if (/from\(["'`]wms_tasks["'`]\)\s*\n?\s*\.(insert|update|upsert|delete)/.test(src)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the yard data layer exposes the yard move task lifecycle", () => {
    const src = readFileSync(YARD_HOOKS, "utf8");
    for (const rpc of ["request_yard_move", "complete_yard_move", "cancel_yard_move"]) {
      expect(src, `useYard is missing ${rpc}`).toContain(rpc);
    }
    expect(src).toContain("useYardMoveTasks");
  });

  it("realtime refreshes yard work orders when wms_tasks changes", () => {
    const sync = readFileSync(path.join(SRC, "features/warehouse/realtime/useWmsRealtimeSync.ts"), "utf8");
    expect(sync).toContain('["wms-yard-move-tasks"]');
  });
});
