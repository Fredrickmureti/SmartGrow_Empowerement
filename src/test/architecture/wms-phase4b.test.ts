/**
 * Architecture guard — WMS Phase 4b (Multi-carton packing).
 *
 * Phase 4b introduces three RPCs that own the write side of
 * per-sales-order carton packing:
 *
 *   • open_pack_carton — mints the shipment LPN and creates the
 *     `wms_pack_cartons` row. Never insert cartons directly.
 *   • assign_line_to_carton — the only way to stamp
 *     `wms_pick_wave_lines.packed_carton_id`.
 *   • seal_pack_carton — the only way to set `sealed_at/by` and
 *     seal the underlying shipment LPN. `complete_pack_task` still
 *     closes the per-SO pack task and rolls the wave.
 *
 * Client code that bypasses these RPCs breaks the pack invariants
 * (no orphan cartons, no unsealed shipments, no forged seals) — reject
 * at CI time.
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

describe("wms phase 4b architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("no client code inserts pack cartons directly (must use open_pack_carton)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (
        /from\(\s*["']wms_pack_cartons["']\s*\)/.test(src) &&
        /\.insert\s*\(/.test(src)
      ) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Mint cartons via supabase.rpc("open_pack_carton", ...) — never .from("wms_pack_cartons").insert(...):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no client code seals a carton via a bare UPDATE (must use seal_pack_carton)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (
        /from\(\s*["']wms_pack_cartons["']\s*\)/.test(src) &&
        /\.update\s*\(\s*\{[^}]*sealed_at\s*:/s.test(src)
      ) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Seal cartons via supabase.rpc("seal_pack_carton", ...) — never direct .update({sealed_at:...}):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no client code stamps packed_carton_id via a bare UPDATE (must use assign_line_to_carton)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (
        /from\(\s*["']wms_pick_wave_lines["']\s*\)/.test(src) &&
        /\.update\s*\(\s*\{[^}]*packed_carton_id\s*:/s.test(src)
      ) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Assign lines via supabase.rpc("assign_line_to_carton", ...) — never direct .update({packed_carton_id:...}):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("PackStation calls the sanctioned carton RPCs", () => {
    const src = readFileSync(path.join(SRC, "pages/warehouse/PackStation.tsx"), "utf8");
    expect(/rpc\(\s*["']open_pack_carton["']/.test(src)).toBe(true);
    expect(/rpc\(\s*["']assign_line_to_carton["']/.test(src)).toBe(true);
    expect(/rpc\(\s*["']seal_pack_carton["']/.test(src)).toBe(true);
    expect(/rpc\(\s*["']complete_pack_task["']/.test(src)).toBe(true);
  });
});
