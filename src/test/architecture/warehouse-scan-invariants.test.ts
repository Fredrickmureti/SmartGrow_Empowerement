/**
 * Architecture guard — warehouse scan invariants (Phase 5).
 *
 * Three rules keep the subsystem from drifting back into the state the
 * 2026-08 audit found. Each one failed somewhere in the tree before this
 * guard existed, so each is a regression test, not a style preference.
 *
 *   1. ONE ROUTER SEAM. Warehouse code registers scan targets through
 *      `useWmsScanIntent` (or a sanctioned field that wraps it) — never by
 *      calling `scanRouter.register` directly. Direct registration skips the
 *      GS1 pre-parse, the entity kind check and the shared feedback channel.
 *   2. NO PRIVATE DECODERS. Warehouse code never listens to raw keystrokes.
 *      The single wedge decoder owns that (see single-wedge-decoder.test.ts);
 *      a local keydown buffer forks it silently.
 *   3. SCAN MUTATIONS STAY IDEMPOTENT. RF screens write through the offline
 *      queue, which carries `client_scan_id` into `wms_replay_guarded_call`.
 *      A direct `supabase.rpc` from an RF screen double-applies on replay.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WAREHOUSE_DIRS = [
  "src/pages/warehouse-mobile",
  "src/pages/warehouse",
  "src/features/warehouse",
  "src/apps/warehouse-mobile",
].map((d) => join(process.cwd(), d));

/**
 * The scanning primitives themselves legitimately touch the router and the
 * key stream — they ARE the seam every other file must go through.
 */
const SEAM_FILES = [
  "features/warehouse/scanning/wmsScanIntent.ts",
  "features/warehouse/scanning/EntityScanField.tsx",
  "features/warehouse/scanning/ScanGuidance.tsx",
  "features/warehouse/scanning/useActiveScanTarget.ts",
  "features/warehouse/locations/BinScanField.tsx",
];

function files(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out = out.concat(files(full));
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const ALL = WAREHOUSE_DIRS.flatMap(files);
const rel = (f: string) => f.slice(f.indexOf("src"));
const isSeam = (f: string) => SEAM_FILES.some((s) => f.endsWith(s));

describe("warehouse scan invariants", () => {
  it("finds the warehouse source tree", () => {
    expect(ALL.length).toBeGreaterThan(50);
  });

  it("no warehouse file registers a scan target outside the intent engine", () => {
    const offenders = ALL.filter(
      (f) => !isSeam(f) && /scanRouter\s*\.\s*register\s*\(/.test(readFileSync(f, "utf8")),
    ).map(rel);
    expect(
      offenders,
      `Register scan targets with useWmsScanIntent, not scanRouter.register:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no warehouse file runs its own keystroke decoder", () => {
    const offenders = ALL.filter((f) => {
      if (isSeam(f)) return false;
      const src = readFileSync(f, "utf8");
      // A keydown listener that accumulates characters = a private wedge decoder.
      const listens = /addEventListener\(\s*["'`]keydown["'`]/.test(src);
      const buffers = /(e|ev|event)\.key\.length\s*===?\s*1/.test(src) || /bufferRef|scanBuffer/.test(src);
      return listens && buffers;
    }).map(rel);
    expect(
      offenders,
      `Keyboard-wedge decoding belongs to KeyboardScannerDriver alone:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("RF screens route scan mutations through the idempotent offline queue", () => {
    const offenders: string[] = [];
    for (const f of files(join(process.cwd(), "src/pages/warehouse-mobile"))) {
      const src = readFileSync(f, "utf8");
      const scans = src.includes("useWmsScanIntent") || /<(Bin|Product|Entity)ScanField/.test(src);
      if (!scans) continue;
      const mutatesDirectly = /supabase\s*\.\s*rpc\s*\(/.test(src);
      const usesQueue = /enqueue|offlineQueue|wms_replay_guarded_call|client_scan_id/.test(src);
      if (mutatesDirectly && !usesQueue) offenders.push(rel(f));
    }
    expect(
      offenders,
      `Scan-driven writes must carry a client_scan_id through the offline queue:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
