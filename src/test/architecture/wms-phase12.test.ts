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

  // ADR 0105 Phase 8 — the legacy carton catalogue is decommissioned. The
  // table, its cartonizer pair and the shadow column no longer exist, so
  // nothing in the client may name them. `packaging-master.test.ts` owns the
  // engine wiring guard for BOTH pack stations.
  it("no legacy carton catalogue identifier survives in client code", () => {
    const legacy = /wms_carton_types|carton_type_id|["']suggest_carton["']|["']assign_carton_to_pack["']/;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (legacy.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(
      offenders,
      `Legacy carton catalogue is dropped (ADR 0105 Phase 8):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("CrossdockBoard calls the required RPCs", () => {
    const src = readFileSync(path.join(SRC, "pages/warehouse/CrossdockBoard.tsx"), "utf8");
    expect(src).toMatch(/rpc\(\s*["']confirm_crossdock_stage["']/);
    expect(src).toMatch(/rpc\(\s*["']cancel_crossdock_opportunity["']/);
    expect(src).toMatch(/from\(\s*["']wms_crossdock_opportunities["']/);
  });



  it("route and nav wire /crossdock and the packaging catalogue", () => {
    const routes = readFileSync(path.join(SRC, "apps/warehouse/routes.tsx"), "utf8");
    const nav = readFileSync(path.join(SRC, "apps/warehouse/nav.ts"), "utf8");
    expect(/path="crossdock"/.test(routes)).toBe(true);
    expect(/path="packaging"/.test(routes)).toBe(true);
    // legacy path stays reachable, but only as a redirect
    expect(/path="cartons" element=\{<Navigate/.test(routes)).toBe(true);
    expect(nav.includes("/warehouse-app/crossdock")).toBe(true);
    expect(nav.includes("/warehouse-app/packaging")).toBe(true);
    expect(nav.includes("/warehouse-app/cartons")).toBe(false);
  });
});
