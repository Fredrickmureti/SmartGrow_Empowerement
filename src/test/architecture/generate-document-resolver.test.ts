/**
 * Phase 6 guard — `generate-document` MUST resolve a document's physical
 * printer through the canonical chain:
 *
 *   policy.device_assignment_id → policy.intent → resolve_device(role)
 *
 * Any regression that drops the `resolve_device` intent branch, drops the
 * `hardware.route.decision` log, or reintroduces role dispatch outside this
 * one seam re-fragments the resolver. Source-inspection guard — matches the
 * pattern used by `pos-receipt-resolver.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(__dirname, "../../../supabase/functions/generate-document/index.ts"),
  "utf-8",
);

describe("generate-document · Phase 6 canonical resolver", () => {
  it("pins on policy.device_assignment_id and has no legacy printer-profile pin", () => {
    expect(SRC).toMatch(/policy\.device_assignment_id/);
    expect(SRC).not.toMatch(/printer_profile_id/);
  });

  it("falls through to `resolve_device` when the policy carries only an intent", () => {
    expect(SRC).toMatch(/policy\.intent/);
    expect(SRC).toMatch(/roleForIntent/);
    expect(SRC).toMatch(/supabase\.rpc\(\s*["']resolve_device["']/);
  });

  it("emits exactly one `hardware.route.decision` per resolved policy", () => {
    const matches = SRC.match(/\[hardware\.route\.decision\]/g) ?? [];
    // Two hot lanes exist in the file: the POS/kitchen ones live in the
    // client hook. This edge function must log at least once per policy
    // resolution — Phase 6 DoD grep counts one entry per print.
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(SRC).toMatch(/surface:\s*["']generate-document["']/);
  });

  it("never revives the legacy `source_config_id` fan-out", () => {
    // Phase 6 dropped `printer_profiles` and the `source_config_id` mirror;
    // every lookup matches `device_assignments.id` directly.
    expect(SRC).not.toMatch(/source_config_id/);
    expect(SRC).not.toMatch(/profile_pin/);
  });

  it("never dispatches to `resolve_device` for the preview-override branch (that path is ID-pinned)", () => {
    // The preview override lookup uses `previewProfileId`; a `resolve_device`
    // call in that neighbourhood would re-route previews away from the pinned
    // profile the operator selected.
    const previewIdx = SRC.indexOf("previewProfileId");
    if (previewIdx > -1) {
      const window = SRC.slice(previewIdx, previewIdx + 800);
      expect(window).not.toMatch(/resolve_device/);
    }
  });
});
