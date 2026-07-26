/**
 * Phase 5 Step B — architectural guard for host-runtime access.
 *
 * The audit found ~30 direct `window.pos.isElectron` / `window.pos.hardware.exec`
 * reads scattered across `HardwareClient.ts`. Phase 5 Step B introduces
 * `src/services/hardware/transport/HostRouter.ts` as the single source
 * of truth. This guard enforces that only a whitelisted set of files
 * may touch the raw preload bridge — new code must import from
 * `HostRouter` or `TransportRouter`.
 *
 * Failure of this test means someone added a `window.pos.*` read
 * outside the whitelist. Fix by importing `ipcAvailable` or
 * `isElectronHost` from `@/services/hardware/transport/HostRouter`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");

/**
 * Files allowed to read `window.pos.*` directly. Everything else must
 * consult HostRouter/TransportRouter or the exported `hardwareClient`
 * namespaces.
 */
const ALLOWED = new Set<string>([
  "types/electron.d.ts",
  "lib/environment.ts",
  "services/hardware/transport/HostRouter.ts",
  "services/hardware/transport/TransportRouter.ts",
  // HardwareClient still contains legacy inline `window.pos` reads
  // inside the devices/customerDisplay/agent/bluetooth namespaces.
  // Step C will migrate each namespace to HostRouter; until then the
  // file remains on the allow-list. Removing this line is the DoD
  // signal for Step C completion.
  "services/hardware/HardwareClient.ts",
  // Renderer-side shells that talk to their own preload surface:
  "services/hardware/BrowserHardwareAdapter.ts",
  "services/hardware/local-display/CustomerDisplayClient.ts",
  // UI diagnostics page reads capability probe directly for display:
  "apps/platform/hardware/HardwareDevices.tsx",
  // PDF viewer needs to know about the Electron file:// quirk:
  "components/common/SafePdfViewer.tsx",
  // Tests that inspect the surface as text:
  "test/pos/no-raw-electron-api.test.ts",
  "test/pos/preload-surface-shape.test.ts",
  "test/pos/hardware-client-routing.test.ts",
  "test/pos/hardware-devices-page.test.tsx",
  "test/architecture/host-router-single-source.test.ts",
]);

const PATTERNS = [/window\.pos\?\.hardware/, /window\.pos\.hardware/, /window\.pos\?\.isElectron/, /window\.pos\.isElectron/];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("Phase 5 Step B — HostRouter single-source-of-truth", () => {
  it("no new files read window.pos.* directly outside the allow-list", () => {
    const files = walk(ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).replaceAll("\\", "/");
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (PATTERNS.some((p) => p.test(src))) offenders.push(rel);
    }
    expect(offenders, `Import ipcAvailable/isElectronHost from '@/services/hardware/transport/HostRouter' instead of reading window.pos directly. Offenders:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("HostRouter exports the canonical accessor surface", async () => {
    const mod = await import("@/services/hardware/transport/HostRouter");
    expect(typeof mod.ipcAvailable).toBe("function");
    expect(typeof mod.isElectronHost).toBe("function");
    expect(typeof mod.hasStalePreload).toBe("function");
    expect(typeof mod.hostRouter.snapshot).toBe("function");
  });

  it("HardwareClient exposes the blessed execAssignment entrypoint", async () => {
    const { hardwareClient } = await import("@/services/hardware/HardwareClient");
    expect(typeof hardwareClient.execAssignment).toBe("function");
  });
});
