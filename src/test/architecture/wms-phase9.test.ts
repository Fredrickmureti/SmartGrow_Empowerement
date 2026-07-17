/**
 * Architecture guard — WMS Phase 9 (Yard & Trailer Management).
 *
 * - `wms_trailer_visits` is RPC-only. No client code may
 *   insert/update/delete it directly; every state transition MUST go
 *   through `check_in_trailer` / `assign_trailer_to_dock` /
 *   `depart_trailer`.
 * - `wms_yard_slots` is master data — client writes are allowed, but
 *   only from the YardBoard page (defence in depth against random
 *   inserts elsewhere).
 * - The YardBoard page must call all three RPCs.
 * - Nav + routes wire `/warehouse-app/yard`.
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

describe("wms phase 9 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("no client code writes to wms_trailer_visits (RPC-only)", () => {
    const offenders: string[] = [];
    const banned = /from\(\s*["']wms_trailer_visits["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (banned.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(
      offenders,
      `Use check_in_trailer / assign_trailer_to_dock / depart_trailer RPCs instead:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("wms_yard_slots writes originate only from the YardBoard page", () => {
    const offenders: string[] = [];
    const allowed = path.join(SRC, "pages/warehouse/YardBoard.tsx");
    const write = /from\(\s*["']wms_yard_slots["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    for (const f of files) {
      if (f === allowed) continue;
      const src = readFileSync(f, "utf8");
      if (write.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it("YardBoard page calls the three yard RPCs", () => {
    const src = readFileSync(path.join(SRC, "pages/warehouse/YardBoard.tsx"), "utf8");
    expect(/rpc\(\s*["']check_in_trailer["']/.test(src)).toBe(true);
    expect(/rpc\(\s*["']assign_trailer_to_dock["']/.test(src)).toBe(true);
    expect(/rpc\(\s*["']depart_trailer["']/.test(src)).toBe(true);
  });

  it("nav wires the yard page", () => {
    const nav = readFileSync(path.join(SRC, "apps/warehouse/nav.ts"), "utf8");
    expect(nav.includes("/warehouse-app/yard")).toBe(true);
  });

  it("routes register /yard", () => {
    const routes = readFileSync(path.join(SRC, "apps/warehouse/routes.tsx"), "utf8");
    expect(/path="yard"/.test(routes)).toBe(true);
  });
});
