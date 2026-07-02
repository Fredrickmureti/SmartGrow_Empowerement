/**
 * Architecture guard (H2) — the install edge function must consult the
 * `check_pack_install_allowed` RPC before invoking
 * `install_localization_pack_atomic`. Removes the gate by accident and
 * skeleton packs go live silently.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const FN = path.resolve(
  __dirname,
  "../../../supabase/functions/install-localization-pack/index.ts",
);

describe("pack-skeleton-install-gate", () => {
  it("install fn calls check_pack_install_allowed before install", () => {
    const src = readFileSync(FN, "utf8");
    const gateIdx = src.indexOf('"check_pack_install_allowed"');
    const installIdx = src.indexOf('"install_localization_pack_atomic"');
    expect(gateIdx).toBeGreaterThan(0);
    expect(installIdx).toBeGreaterThan(0);
    // The gate must run BEFORE the install RPC call.
    expect(gateIdx).toBeLessThan(installIdx);
  });

  it("install fn forwards acknowledge_skeleton from the request body", () => {
    const src = readFileSync(FN, "utf8");
    expect(src).toMatch(/acknowledge_skeleton/);
  });
});