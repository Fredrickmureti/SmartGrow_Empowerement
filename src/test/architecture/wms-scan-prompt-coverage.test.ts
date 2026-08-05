/**
 * Architecture guard — every "scan the X" prompt runs through the intent engine.
 *
 * An RF screen that renders a bare `<Input placeholder="Scan …">` is a
 * scan prompt that a wedge gun, ring scanner and camera cannot reach: it
 * requires a focused input, skips the identity gate, skips wrong-kind
 * refusal, and skips shared audio/haptic feedback. Scan prompts must be
 * one of the three sanctioned fields:
 *
 *   BinScanField      → positions
 *   ProductScanField  → products
 *   EntityScanField   → LPNs, cartons, manifests, trailers, gate passes
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SCAN_SURFACES = [
  join(process.cwd(), "src/pages/warehouse-mobile"),
  join(process.cwd(), "src/apps/warehouse-mobile"),
];

/** The sanctioned fields themselves legitimately render the raw input. */
const SANCTIONED = ["BinScanField", "ProductScanField", "EntityScanField"];

/**
 * Desktop execution mirrors — screens that stand where physical work
 * happens. Each must own a scan path (a sanctioned field or a declared
 * WMS intent); a wedge gun typing into an unguarded input here is worse
 * than no scanning at all.
 */
const EXECUTION_MIRRORS = [
  "src/pages/warehouse/PackStation.tsx",
  "src/pages/warehouse/LoadingBay.tsx",
  "src/pages/warehouse/GateConsole.tsx",
  "src/pages/warehouse/YardMarshal.tsx",
  "src/pages/warehouse/LicensePlateView.tsx",
  "src/pages/warehouse/ReceivingSessions.tsx",
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
    else if (/\.tsx$/.test(full) && !/\.test\.tsx$/.test(full)) out.push(full);
  }
  return out;
}

describe("WMS scan prompt coverage", () => {
  it("no RF screen renders a bare scan input", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_SURFACES) {
      for (const file of files(dir)) {
        const src = readFileSync(file, "utf8");
        if (SANCTIONED.some((c) => file.includes(c))) continue;
        // A `placeholder="Scan …"` on anything other than a sanctioned field.
        const hasBareScanInput = /placeholder=\{?["'`]\s*Scan[^"'`]*["'`]/i.test(src);
        const usesSanctionedField = SANCTIONED.some((c) => src.includes(`<${c}`));
        if (hasBareScanInput && !usesSanctionedField) {
          offenders.push(file.slice(file.indexOf("src")));
        }
      }
    }
    expect(
      offenders,
      `Scan prompts must use BinScanField / ProductScanField / EntityScanField:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every desktop execution mirror owns a scan path", () => {
    const missing = EXECUTION_MIRRORS.filter((rel) => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      return !SANCTIONED.some((c) => src.includes(`<${c}`)) && !src.includes("useWmsScanIntent");
    });
    expect(
      missing,
      `These screens mirror physical work and must register a scan path:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * Phase 4.5 — a handheld operator has no wedge gun. An RF screen that
   * registers a scan intent but never passes `scanLabel` renders no camera
   * affordance, so on a phone the prompt is unreachable.
   */
  it("every RF screen with a scan intent offers the camera affordance", () => {
    const offenders: string[] = [];
    for (const file of files(join(process.cwd(), "src/pages/warehouse-mobile"))) {
      const src = readFileSync(file, "utf8");
      const hasIntent = src.includes("useWmsScanIntent") || SANCTIONED.some((c) => src.includes(`<${c}`));
      if (!hasIntent) continue;
      if (!src.includes("MobileWarehouseLayout")) continue;
      if (!/scanLabel[=:]/.test(src)) offenders.push(file.slice(file.indexOf("src")));
    }
    expect(
      offenders,
      `RF screens with a scan prompt must pass scanLabel so handheld operators can scan:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  /** The guidance surface is layout-owned; screens must not re-implement it. */
  it("the RF layout renders the single guidance surface", () => {
    const layout = readFileSync(
      join(process.cwd(), "src/apps/warehouse-mobile/MobileWarehouseLayout.tsx"),
      "utf8",
    );
    expect(layout).toContain("<ScanGuidance");
  });
});
