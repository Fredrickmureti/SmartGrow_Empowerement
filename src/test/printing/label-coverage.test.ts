/**
 * Phase 17 — Wiring coverage guardrail.
 *
 * Every module that needs to print a physical label MUST go through the
 * `useLabelPrint` seam (or its shared `PrintLabelButton` wrapper), which
 * owns barcode-identity refusal (ADR-0089), the missing-device CTA, and
 * workflow-bound printer routing (ADR-0086). This test locks in the set
 * of caller pages so regressions (someone reaching for `hardwareClient`
 * or raw ZPL again) are caught at test time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = (p: string) => resolve(__dirname, "../../", p);

const CALLERS: { path: string; template: string; workflow: string }[] = [
  { path: "pages/Products.tsx", template: "product_label", workflow: "product_tag" },
  { path: "pages/Products.tsx", template: "shelf_label", workflow: "shelf_edge" },
  { path: "pages/inventory/LotDetail.tsx", template: "lot_label", workflow: "product_tag" },
  { path: "pages/warehouse/PutawayQueue.tsx", template: "bin_label", workflow: "receiving" },
  { path: "pages/warehouse-mobile/MobileReceive.tsx", template: "receiving_label", workflow: "receiving" },
  { path: "pages/warehouse/PackStation.tsx", template: "pallet_label", workflow: "receiving" },
  { path: "pages/warehouse/PackStation.tsx", template: "shipping_label", workflow: "shipping" },
];

describe("Label print coverage (Phase 17)", () => {
  for (const c of CALLERS) {
    it(`${c.path} dispatches ${c.template} via ${c.workflow}`, () => {
      const src = readFileSync(R(c.path), "utf-8");
      expect(src).toMatch(new RegExp(`["']${c.template}["']`));
      expect(src).toMatch(new RegExp(`["']${c.workflow}["']`));
    });

    it(`${c.path} never reaches around the seam to hardwareClient or raw ZPL`, () => {
      const src = readFileSync(R(c.path), "utf-8");
      expect(src).not.toMatch(/hardwareClient\.printRawBytes/);
      expect(src).not.toMatch(/\^XA[\s\S]*\^XZ/);
    });
  }
});