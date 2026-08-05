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

const CALLERS: { path: string; template: string; workflow: string; templateRef?: string }[] = [
  { path: "pages/Products.tsx", template: "product_label", workflow: "product_tag" },
  { path: "pages/Products.tsx", template: "shelf_label", workflow: "shelf_edge" },
  { path: "pages/inventory/LotDetail.tsx", template: "lot_label", workflow: "product_tag" },
  { path: "pages/warehouse/PutawayQueue.tsx", template: "bin_label", workflow: "receiving" },
  {
    // Receiving audit Phase 7 — routed through the canonical WMS label key.
    path: "pages/warehouse-mobile/MobileReceiveSession.tsx",
    template: "wms.label.putaway",
    templateRef: "WMS_LABEL_KEY\\.PUTAWAY",
    workflow: "receiving",
  },
  { path: "pages/warehouse/PackStation.tsx", template: "pallet_label", workflow: "receiving" },
  { path: "pages/warehouse/PackStation.tsx", template: "shipping_label", workflow: "shipping" },
  // POS callers (Phase 17 · step 15).
  { path: "components/pos/ProductQuickView.tsx", template: "product_label", workflow: "product_tag" },
  { path: "components/pos/ProductQuickView.tsx", template: "shelf_label", workflow: "shelf_edge" },
  { path: "components/pos/CartItemEditor.tsx", template: "shelf_label", workflow: "shelf_edge" },
];

describe("Label print coverage (Phase 17)", () => {
  for (const c of CALLERS) {
    it(`${c.path} dispatches ${c.template} via ${c.workflow}`, () => {
      const src = readFileSync(R(c.path), "utf-8");
      expect(src).toMatch(new RegExp(c.templateRef ?? `["']${c.template}["']`));
      expect(src).toMatch(new RegExp(`["']${c.workflow}["']`));
    });


    it(`${c.path} never reaches around the seam to hardwareClient or raw ZPL`, () => {
      const src = readFileSync(R(c.path), "utf-8");
      expect(src).not.toMatch(/hardwareClient\.printRawBytes/);
      expect(src).not.toMatch(/\^XA[\s\S]*\^XZ/);
    });
  }
});
/**
 * Label engine guardrail — bulk labelling must be a server-side run.
 *
 * A client `for` loop over `print()` cannot survive a tab close, has no
 * ledger object, no resume and no retry. Batch entry points therefore go
 * through `useLabelRuns` (`create_label_run` → `expand_label_run`).
 */
const BATCH_ENTRY_POINTS = [
  "features/warehouse/locations/BinLabelDialog.tsx",
  "components/labels/PrintFilteredLabelsButton.tsx",
];

describe("Label engine: no client-side batch print loops", () => {
  for (const path of BATCH_ENTRY_POINTS) {
    it(`${path} submits a label run instead of looping prints`, () => {
      const src = readFileSync(R(path), "utf-8");
      expect(src).toMatch(/useLabelRunActions/);
      expect(src).not.toMatch(/useLabelPrint/);
      // no `for (... of ...) { await print(...) }` style batching
      expect(src).not.toMatch(/for\s*\([^)]*\)\s*\{[\s\S]{0,400}await\s+print\(/);
    });
  }
});
