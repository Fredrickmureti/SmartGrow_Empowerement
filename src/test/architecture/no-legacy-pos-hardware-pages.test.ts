/**
 * Wave 9b architecture guard — the hardware editor and diagnostics pages
 * have been relocated to `src/apps/platform/hardware/`. Any new import of
 * the old `@/pages/pos/HardwareDevices` or `@/pages/pos/HardwareDiagnostics`
 * paths is a regression that re-couples hardware to the POS app module.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");
const ALLOWED = new Set<string>([
  "test/architecture/no-legacy-pos-hardware-pages.test.ts",
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".tanstack") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("legacy pos/HardwareDevices(.Diagnostics) imports forbidden (Wave 9b)", () => {
  it("no src/ file imports the old POS-tree hardware page paths", () => {
    const re = /@\/pages\/pos\/Hardware(Devices|Diagnostics)/;
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(abs, "utf-8");
      if (re.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Files importing the old hardware page paths:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});