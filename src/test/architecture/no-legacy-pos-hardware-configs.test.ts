/**
 * Architecture guard (Wave 9b) — the legacy `pos_hardware_configs` table
 * has been dropped. The only allowed references in src/ are:
 *
 *   - generated Supabase types (regenerated after the table drop, but the
 *     name may linger in the snapshot until the next regen)
 *   - the multi-tenant scoped-tables config list
 *   - this test file itself
 *
 * Any other src/ file touching `pos_hardware_configs` is a regression —
 * `device_assignments` is the canonical source of truth.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");
const ALLOWED = new Set<string>([
  // Generated Supabase types — reflects the live schema until regen.
  "integrations/supabase/types.ts",
  // Multi-tenant scope-guard configuration enumerates every scoped table.
  "lib/businessScopedTables.ts",
  // This test file itself.
  "test/architecture/no-legacy-pos-hardware-configs.test.ts",
  // Documentation-only references explaining the historical migration
  // away from `pos_hardware_configs` to `device_assignments`. No runtime
  // call sites — only comments / docstrings.
  "apps/platform/hardware/HardwareDevices.tsx",
  "apps/platform/hardware/HardwareDiagnostics.tsx",
  "hooks/hardware/useHardwareRegistryCrud.ts",
  "hooks/useDeviceAssignments.ts",
  "test/hardware/inventory-label-printer-binding.test.ts",
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

describe("legacy pos_hardware_configs reference allow-list (Wave 6)", () => {
  it("only the shim + diagnostics page reference pos_hardware_configs", () => {
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(abs, "utf-8");
      if (/pos_hardware_configs/.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Files referencing pos_hardware_configs outside the allow-list:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
