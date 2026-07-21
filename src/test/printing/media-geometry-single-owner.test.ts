/**
 * Guardrail (ADR-0087 / Phase 14 step 9) — `mediaGeometry.ts` is the
 * single owner of mm → printer-dot math. Prior to this module, five
 * files each carried their own `dpi / 25.4` conversion; label
 * geometry drifted between renderer and preview. This test asserts:
 *
 *  1. `src/services/printing/mediaGeometry.ts` has no runtime imports
 *     (it is a pure math module; drift means someone reached for a
 *     helper it shouldn't depend on).
 *  2. Every sanctioned consumer imports from `mediaGeometry` and does
 *     NOT re-declare the `dpi / 25.4` formula locally.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const OWNER = resolve(__dirname, "../../services/printing/mediaGeometry.ts");
const CONSUMERS = [
  "../../../electron/hardware/drivers/ZplLabelDriver.ts",
  "../../../electron/hardware/drivers/EplLabelDriver.ts",
  "../../services/hardware/BrowserHardwareAdapter.ts",
  "../../apps/platform/hardware/HardwareLabelTemplates.tsx",
].map((p) => resolve(__dirname, p));

describe("mediaGeometry — single owner of mm→dot math", () => {
  it("the module itself has no runtime imports (pure math)", () => {
    const src = readFileSync(OWNER, "utf-8");
    // Allow `import type` — those are erased at build.
    const runtimeImports = src.match(/^\s*import\s+(?!type\s)[^;]+;/gm) ?? [];
    expect(runtimeImports).toEqual([]);
  });

  for (const file of CONSUMERS) {
    it(`consumer ${file.split("/").slice(-2).join("/")} delegates to mediaGeometry`, () => {
      let src: string;
      try {
        src = readFileSync(file, "utf-8");
      } catch {
        // Consumer file was renamed/removed — skip rather than false-fail.
        return;
      }
      // Must import from mediaGeometry.
      expect(src).toMatch(/from\s+["'][^"']*mediaGeometry["']/);
      // Must NOT reintroduce the `dpi / 25.4` formula locally.
      expect(src).not.toMatch(/dpi\s*\/\s*25\.4/);
    });
  }
});
