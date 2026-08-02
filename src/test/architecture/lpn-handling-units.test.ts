/**
 * Architecture guard — ADR 0102, License Plates as handling units.
 *
 * Pins the invariants that keep plates inventory-bearing:
 *   1. `move_lpn` is gone; relocation goes through `wms_lpn_move`.
 *   2. No client code writes plate operational columns directly.
 *   3. Plate contents are read from `stock_quants.lpn_id`, never
 *      `package_id` (that column is product packaging).
 *   4. Plate surfaces subscribe to a WMS scan intent.
 *   5. Plate labels are printed only through the LPN label module.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const SELF = __filename;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(SRC).filter((f) => f !== SELF && !f.includes("integrations/supabase/types.ts"));
const board = path.join(SRC, "pages/warehouse/LicensePlates.tsx");
const cockpit = path.join(SRC, "pages/warehouse/LicensePlateView.tsx");
const ops = path.join(SRC, "features/warehouse/lpn/useLpnOps.ts");
const labels = path.join(SRC, "features/warehouse/lpn/lpnLabels.ts");

describe("ADR 0102 — LPN handling units", () => {
  it("the LPN feature module exists", () => {
    expect(existsSync(ops)).toBe(true);
    expect(existsSync(labels)).toBe(true);
  });

  it("no call site uses the retired move_lpn RPC", () => {
    const offenders = files.filter((f) => /rpc\(\s*["'`]move_lpn/.test(readFileSync(f, "utf8")));
    expect(offenders, `Use wms_lpn_move:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no client code writes plate location or status directly", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("wms_license_plates")) continue;
      if (/from\(["'`]wms_license_plates["'`]\)[\s\S]{0,200}?\.update\(/.test(src)) offenders.push(f);
    }
    expect(offenders, `Mutate plates via RPC:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("plate contents are read from stock_quants.lpn_id, not package_id", () => {
    const src = readFileSync(ops, "utf8");
    expect(src).toMatch(/\.eq\(\s*["'`]lpn_id["'`]/);
    for (const f of [board, cockpit, ops]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/eq\(\s*["'`]package_id["'`]/);
    }
  });

  it("plate operations go through the atomic RPCs", () => {
    const src = readFileSync(ops, "utf8");
    for (const rpc of [
      "wms_lpn_move", "wms_lpn_load", "wms_lpn_unload",
      "wms_lpn_split", "wms_lpn_merge", "wms_lpn_nest", "wms_lpn_unnest",
    ]) {
      expect(src, `${rpc} missing from the operations layer`).toContain(rpc);
    }
  });

  it("both plate surfaces subscribe to a WMS scan intent", () => {
    for (const f of [board, cockpit]) {
      expect(readFileSync(f, "utf8")).toContain("useWmsScanIntent");
    }
  });

  it("plate labels print only through the LPN label module", () => {
    for (const f of [board, cockpit]) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} must not call printWmsLabel directly`).not.toContain("printWmsLabel(");
      expect(src).toContain("LpnLabelDialog");
    }
    expect(readFileSync(labels, "utf8")).toContain("printWmsLabel");
  });

  it("lifecycle vocabulary comes from the FSM rulebook, not the UI", () => {
    const boardSrc = readFileSync(board, "utf8");
    const cockpitSrc = readFileSync(cockpit, "utf8");
    // The board's status facet is fed by the edge-table catalog.
    expect(boardSrc).toContain("useLpnStatusCatalog");
    expect(boardSrc, "status options must not be a hardcoded <SelectItem> list")
      .not.toMatch(/<SelectItem value="sealed"/);
    // Transitions on the cockpit are rendered by the FSM-driven rail.
    expect(cockpitSrc).toContain("LpnLifecycleRail");
    expect(readFileSync(ops, "utf8")).toContain("wms_lpn_status_edges");
  });

  it("the mobile RF plate screen routes every mutation through the offline queue", () => {
    const mobile = resolve(root, "src/pages/warehouse-mobile/MobilePlate.tsx");
    const src = readFileSync(mobile, "utf8");
    expect(src).toContain("enqueue(");
    expect(src, "mobile surfaces must not call supabase.rpc directly")
      .not.toMatch(/supabase\.rpc\(/);
    expect(src).toContain("useWmsScanIntent");
  });
});
