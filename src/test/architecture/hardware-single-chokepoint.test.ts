/**
 * Wave 9b architecture guard — every hardware op must funnel through
 * `hardwareClient`. Direct access to `window.pos.usb`, `window.pos.serial`
 * or `window.pos.hid` from arbitrary src/ files breaks the runtime
 * abstraction (Electron vs browser vs agent) and brings back the
 * fragmentation Wave 9 set out to fix.
 *
 * Allow-list: only the hardware service layer + Electron-aware helpers
 * and the diagnostics page (which intentionally probes the raw surface
 * to report capabilities) may reference these properties directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");
const ALLOWED = new Set<string>([
  // Service layer that owns the Electron bridge.
  "services/hardware/HardwareClient.ts",
  "services/hardware/BrowserHardwareAdapter.ts",
  "services/hardware/transport/ElectronTransport.ts",
  // Hydrator keeps the SQLite cache in sync with the canonical registry.
  "services/hardware/ElectronAssignmentHydrator.ts",
  // Diagnostics page intentionally introspects the raw surface.
  "apps/platform/hardware/HardwareDiagnostics.tsx",
  // Environment probe.
  "lib/environment.ts",
  // This guard itself.
  "test/architecture/hardware-single-chokepoint.test.ts",
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

describe("hardware single chokepoint (Wave 9b)", () => {
  it("no src/ file pokes at window.pos.{usb,serial,hid} outside the allow-list", () => {
    const re = /window\.pos\??\.(usb|serial|hid)\b/;
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(abs, "utf-8");
      if (re.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Files reaching into window.pos.{usb,serial,hid} directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});