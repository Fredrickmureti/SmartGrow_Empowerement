/**
 * Products page label-print seam contract.
 *
 * History: this test originally guarded a seam where `Products.tsx` built ZPL
 * bytes inline, then a later revision where the page called the
 * `printClient.printLabel` façade. Both are gone.
 *
 * The problem with the façade revision was not the façade itself — it was that
 * `Products.tsx` had hand-copied the *whole* label protocol next to it:
 * missing-device refusal, org check, ADR-0089 barcode-identity refusal, the
 * `name / sku / sku_display / barcode / hri_flag` var pack, and its own toast
 * phrasing. Every other label call site in the app (`PrintLabelButton`,
 * `CartItemEditor`, `ProductQuickView`, `FixedAssets`) went through the shared
 * `useLabelPrint` seam, so Products was one edit away from silently drifting
 * out of parity on any of those five rules.
 *
 * What this test locks in now:
 *   1. Products drives labels through the shared `useLabelPrint` seam.
 *   2. It still uses the canonical `product_label` / `shelf_label` template
 *      keys and their workflows.
 *   3. It does NOT re-implement device / identity refusal locally.
 *   4. It does NOT reach around the seam into `printClient`, the
 *      `printLabelByTemplate` primitive, `hardwareClient`, or raw drivers.
 *   5. The page renders a "Print label" row action wired to a handler.
 *   6. The page contains NO raw ZPL strings (defense-in-depth alongside the
 *      `no-raw-zpl-outside-printing` ESLint rule).
 *
 * Source-inspection rather than a render test — Products has dozens of
 * unrelated hook imports whose mocks would dwarf the assertion.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PRODUCTS = resolve(__dirname, "../../pages/Products.tsx");
const SRC = readFileSync(PRODUCTS, "utf-8");

describe("Products label-print seam", () => {
  it("drives labels through the shared useLabelPrint seam", () => {
    expect(SRC).toContain('from "@/hooks/inventory/useLabelPrint"');
    expect(SRC).toMatch(/useLabelPrint\s*\(/);
  });

  it("uses the canonical template keys and workflows", () => {
    expect(SRC).toMatch(/templateKey:\s*["']product_label["']/);
    expect(SRC).toMatch(/workflow:\s*["']product_tag["']/);
    expect(SRC).toMatch(/templateKey:\s*["']shelf_label["']/);
    expect(SRC).toMatch(/workflow:\s*["']shelf_edge["']/);
  });

  it("does NOT re-implement refusal rules the seam already owns", () => {
    // ADR-0089 identity refusal lives in useLabelPrint, once.
    expect(SRC).not.toMatch(/resolveLabelBarcode\s*\(/);
    expect(SRC).not.toMatch(/LABEL_BARCODE_REFUSAL/);
    // The missing-device pre-flight likewise belongs to the seam.
    expect(SRC).not.toMatch(/useInventoryLabelPrinter\s*\(/);
  });

  it("does NOT reach around the seam into the shim, the primitive, or hardware", () => {
    expect(SRC).not.toMatch(/from\s+["']@\/services\/printing\/PrintClient["']/);
    expect(SRC).not.toMatch(/printClient\./);
    expect(SRC).not.toMatch(/printLabelByTemplate\s*\(/);
    expect(SRC).not.toMatch(/from\s+["']@\/services\/printing\/labelDispatch["']/);
    expect(SRC).not.toMatch(/from\s+["']@\/services\/hardware\/drivers\//);
    expect(SRC).not.toMatch(/from\s+["']@\/hooks\/pos\/useHardware/);
    expect(SRC).not.toMatch(/hardwareClient\./);
  });

  it("contains NO raw ZPL byte construction (template-driven now)", () => {
    expect(SRC).not.toMatch(/\^XA/);
    expect(SRC).not.toMatch(/\^XZ/);
  });

  it("renders a Print label row action wired to a handler", () => {
    expect(SRC).toMatch(/Print label/);
    expect(SRC).toMatch(/handlePrintLabel\s*\(/);
  });

  it("surfaces a CTA when no label printer is bound", () => {
    expect(SRC).toMatch(/missingDeviceCta/);
  });
});
