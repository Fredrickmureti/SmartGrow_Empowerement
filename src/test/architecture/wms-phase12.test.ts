/**
 * Architecture guard — WMS Phase 12 (cross-dock & cartonization).
 *
 * - `wms_crossdock_opportunities` is RPC-only from client code.
 * - `wms_carton_types` writes are confined to CartonTypes.tsx.
 * - `wms_pack_cartons.carton_type_id` is only stamped through the
 *   `assign_carton_to_pack` RPC (no direct client update to that column).
 * - Cross-dock and carton pages are wired into routes + nav.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { domainCallRe } from "./wmsGuardUtils";

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

describe("wms phase 12 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("wms_crossdock_opportunities is RPC-only from the client", () => {
    const banned = /from\(\s*["']wms_crossdock_opportunities["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (banned.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders, `wms_crossdock_opportunities is RPC-only:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("wms_carton_types writes originate only from CartonTypes.tsx", () => {
    const allowed = path.join(SRC, "pages/warehouse/CartonTypes.tsx");
    const write = /from\(\s*["']wms_carton_types["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    const offenders: string[] = [];
    for (const f of files) {
      if (f === allowed) continue;
      const src = readFileSync(f, "utf8");
      if (write.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it("no client writes to wms_pack_cartons.carton_type_id (assign_carton_to_pack RPC only)", () => {
    const banned = /carton_type_id\s*:/;
    const packWrite = /from\(\s*["']wms_pack_cartons["']\s*\)\s*\.(insert|update|upsert)\s*\(/;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (packWrite.test(src) && banned.test(src)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders, `Use assign_carton_to_pack RPC instead:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("CrossdockBoard calls the required RPCs", () => {
    const src = readFileSync(path.join(SRC, "pages/warehouse/CrossdockBoard.tsx"), "utf8");
    expect(src).toMatch(/rpc\(\s*["']confirm_crossdock_stage["']/);
    expect(src).toMatch(/rpc\(\s*["']cancel_crossdock_opportunity["']/);
    expect(src).toMatch(/from\(\s*["']wms_crossdock_opportunities["']/);
  });

  it("PackStation wires suggest_carton + assign_carton_to_pack (Phase 12.1)", () => {
    const src = readFileSync(path.join(SRC, "pages/warehouse/PackStation.tsx"), "utf8");
    expect(src).toMatch(/rpc\(\s*["']suggest_carton["']/);
    expect(src).toMatch(domainCallRe("assign_carton_to_pack"));
  });

  it("route and nav wire /crossdock and /cartons", () => {
    const routes = readFileSync(path.join(SRC, "apps/warehouse/routes.tsx"), "utf8");
    const nav = readFileSync(path.join(SRC, "apps/warehouse/nav.ts"), "utf8");
    expect(/path="crossdock"/.test(routes)).toBe(true);
    expect(/path="cartons"/.test(routes)).toBe(true);
    expect(nav.includes("/warehouse-app/crossdock")).toBe(true);
    expect(nav.includes("/warehouse-app/cartons")).toBe(true);
  });
});
