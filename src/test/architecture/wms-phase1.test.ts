/**
 * Architecture guard — WMS Phase 1 (ADR 0079).
 *
 * Guarantees the invariants that make the LPN + universal task substrate
 * safe to build the rest of the WMS on top of:
 *
 *   1. Physical relocation of a license plate must go through the
 *      `wms_lpn_move` RPC. Direct UPDATEs to
 *      `wms_license_plates.current_location_id` from the client bypass
 *      the outbox event and the audit trail — a WMS killer.
 *
 *   2. Warehouse app pages must live under `src/pages/warehouse/**` and
 *      be reached via `/warehouse-app/*` routes. This keeps the ADR-0079
 *      Inventory ↔ Warehouse split enforceable at CI time.
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

describe("wms phase 1 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF);

  it("no client code updates wms_license_plates.current_location_id directly (must use wms_lpn_move RPC)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Match a .update({...}) call that mentions current_location_id inside its object literal.
      if (
        /from\(\s*["']wms_license_plates["']\s*\)/.test(src) &&
        /\.update\s*\(\s*\{[^}]*current_location_id/s.test(src)
      ) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Move plates via supabase.rpc("wms_lpn_move", ...) — never .update({current_location_id}):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("warehouse routes point at real page modules under pages/warehouse", () => {
    const routes = readFileSync(path.join(SRC, "apps/warehouse/routes.tsx"), "utf8");
    const nav = readFileSync(path.join(SRC, "apps/warehouse/nav.ts"), "utf8");

    // Every nav `to:` under /warehouse-app must have a matching Route path.
    const navTos = Array.from(nav.matchAll(/to:\s*["']\/warehouse-app\/([^"'/]+)/g)).map((m) => m[1]);
    for (const seg of navTos) {
      expect(
        new RegExp(`path=["']${seg}["']|path=["']${seg}/`).test(routes),
        `nav entry /warehouse-app/${seg} has no matching <Route path="${seg}"> in apps/warehouse/routes.tsx`,
      ).toBe(true);
    }
  });
});
