/**
 * Wave 9c architecture guard — hardware is a platform concern, not a POS
 * module concern. The Wave 9b page relocation moved the hardware
 * surfaces under `apps/platform/hardware/`; this guard prevents the
 * supporting component + hook from drifting back into the POS tree.
 *
 * Specifically it forbids:
 *   - `src/components/pos/DeviceRegistryCard*` (moved to
 *     `src/components/hardware/DeviceRegistryCard.tsx`)
 *   - `src/hooks/pos/useHardwareProxy*` (moved to
 *     `src/hooks/hardware/useHardwareProxy.ts`)
 *
 * It also forbids any `src/` file from importing those legacy paths so
 * a fresh re-export shim can't silently reintroduce the scope leak.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");

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

describe("hardware not pos-scoped (Wave 9c)", () => {
  it("the legacy POS-scoped hardware files do not exist", () => {
    const legacy = [
      "components/pos/DeviceRegistryCard.tsx",
      "components/pos/DeviceRegistryCard.ts",
      "hooks/pos/useHardwareProxy.ts",
      "hooks/pos/useHardwareProxy.tsx",
    ];
    const survivors = legacy.filter((p) => existsSync(join(ROOT, p)));
    expect(
      survivors,
      `Hardware files must live under components/hardware/ and hooks/hardware/, not under */pos/:\n${survivors.join("\n")}`,
    ).toEqual([]);
  });

  it("no src/ file imports the legacy POS-scoped hardware paths", () => {
    const re = /@\/(components\/pos\/DeviceRegistryCard|hooks\/pos\/useHardwareProxy)\b/;
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      // The guard itself references the legacy paths as string literals.
      if (rel === "test/architecture/hardware-not-pos-scoped.test.ts") continue;
      const text = readFileSync(abs, "utf-8");
      if (re.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Files importing legacy POS-scoped hardware paths:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});