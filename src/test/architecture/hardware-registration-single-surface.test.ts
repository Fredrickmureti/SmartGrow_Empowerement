/**
 * Hardware Registration — single-surface invariant.
 *
 * The Hardware Platform must expose exactly ONE authoritative device-
 * registration UI: `DeviceRegistryCard`, embedded in the platform-owned
 * `HardwareDevices` page under `/platform/hardware/devices`. The previous
 * `DeviceWizard` page (`/platform/hardware/devices/new`) was a parallel
 * registration flow that wrote to the same `device_assignments` table but
 * used a HARDCODED, hallucinated driver catalog (`zpl_label`, `epl_label`,
 * `escpos_label`) that never existed in the renderer `DriverRegistry`, so
 * every "Add device" submission from that page persisted a `driver_type`
 * the runtime could not resolve — silent drift the user experienced as
 * "the dropdown is broken".
 *
 * This test locks the consolidation: no `DeviceWizard.tsx` file, no
 * `/devices/new` UI route (only a redirect), and no hardcoded role→driver
 * lookup tables outside `DriverRegistry`. If you are intentionally
 * relocating the registration surface, update this test in the same
 * commit.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..");

describe("Hardware registration is single-surface", () => {
  it("does not resurrect the legacy DeviceWizard file", () => {
    expect(
      existsSync(resolve(ROOT, "src/apps/platform/hardware/DeviceWizard.tsx")),
    ).toBe(false);
  });

  it("routes /devices/new to a redirect (Navigate), never to a wizard page", () => {
    const src = readFileSync(
      resolve(ROOT, "src/apps/platform/hardware/routes.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/DeviceWizard/);
    // The path must still exist so bookmarks resolve, but only as a redirect.
    const routeMatch = src.match(/path="devices\/new"[^/]*element=\{([^}]+)\}/);
    expect(routeMatch, "devices/new route missing").not.toBeNull();
    expect(routeMatch![1]).toMatch(/Navigate/);
  });

  it("only DriverRegistry owns the role→driver_type catalog", () => {
    // Hardcoded lookup tables in UI components caused the DeviceWizard
    // drift. Callers must go through `getDriversForRole()`.
    const suspicious = [
      "src/apps/platform/hardware/HardwareDevices.tsx",
      "src/components/hardware/DeviceRegistryCard.tsx",
    ];
    for (const rel of suspicious) {
      const src = readFileSync(resolve(ROOT, rel), "utf8");
      expect(
        src,
        `${rel} must not hardcode role→driver mappings; use getDriversForRole`,
      ).not.toMatch(/['"]zpl_label['"]\s*[:,]/);
    }
  });
});