/**
 * Phase 3C guard — `generate-document` MUST resolve a document's physical
 * printer through the canonical chain:
 *
 *   policy.device_assignment_id → policy.printer_profile_id (legacy) →
 *   policy.intent → resolve_device(role)
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

describe("generate-document · Phase 3C canonical resolver", () => {
  it("prefers policy.device_assignment_id before the legacy printer_profile_id pin", () => {
    expect(SRC).toMatch(/policy\.device_assignment_id/);
    const devIdx = SRC.indexOf("policy.device_assignment_id");
    const profIdx = SRC.indexOf("policy.printer_profile_id", devIdx);
    expect(devIdx).toBeGreaterThan(-1);
    expect(profIdx).toBeGreaterThan(devIdx);
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

  it("keeps the `.or(id, source_config_id)` fan-out ONLY for the legacy profile_pin branch", () => {
    // Fan-out must be gated behind routeDecisionSource === 'profile_pin' so
    // the canonical device_assignment_id and intent paths never revive the
    // legacy string-match join.
    expect(SRC).toMatch(
      /routeDecisionSource\s*===\s*["']profile_pin["']\s*\?\s*[\s\S]{0,120}source_config_id/,
    );
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
