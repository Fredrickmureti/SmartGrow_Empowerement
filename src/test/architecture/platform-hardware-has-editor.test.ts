/**
 * Wave 9 architecture guard — the platform hardware page MUST mount the
 * registry editor.
 *
 * Wave 8 removed the embedded `DeviceRegistryCard` from POS Settings and
 * told operators to "open Platform → Hardware". But the platform page
 * never gained the editor itself, so production briefly had ZERO UI
 * surface for scanning, adding, choosing a driver, or assigning a role —
 * a silent, severe regression that this test prevents from recurring.
 *
 * If you are intentionally moving the editor surface elsewhere, update
 * this test to point at the new location in the same commit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(__dirname, "../../apps/platform/hardware/HardwareDevices.tsx");
const src = readFileSync(FILE, "utf-8");

describe("Platform Hardware page (Wave 9 single-editor invariant)", () => {
  it("imports DeviceRegistryCard from the platform component tree", () => {
    // Wave 9c moved the component out of components/pos/ into
    // components/hardware/. Accept only the platform-owned path.
    expect(src).toMatch(
      /import\s+\{[^}]*DeviceRegistryCard[^}]*\}\s+from\s+["']@\/components\/hardware\/DeviceRegistryCard["']/,
    );
  });

  it("renders <DeviceRegistryCard>", () => {
    expect(src).toMatch(/<DeviceRegistryCard[\s/>]/);
  });

  it("links operators to hardware diagnostics for triage", () => {
    expect(src).toContain("/platform/hardware/diagnostics");
  });
});
