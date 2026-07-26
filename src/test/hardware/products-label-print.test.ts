/**
 * Wave B2.2 — Products page label-print seam contract.
 *
 * History: this test originally guarded the Wave 9f seam where Products.tsx
 * built ZPL bytes inline and shipped them through
 * `useInventoryLabelPrinter().printLabelBytes(...)`. The audit in
 * `docs/audit/2026-06-17-hardware-enterprise-readiness.md` (§2.B + risk B2.2)
 * called out that the inline-ZPL path bypassed the `label_templates`
 * registry and prevented branch overrides, price tokens, and template
 * versioning. B2.2 of the execution plan in `.lovable/plan.md` routes the
 * page through the template-driven dispatch, and Phase 3 of the hardware
 * consolidation moved every consumer to the single `printClient.printLabel`
 * façade so the platform has one chokepoint for template-driven labels.
 *
 * What this test locks in now:
 *   1. Products imports `useInventoryLabelPrinter` (for the missing-device
 *      CTA) AND the `printClient` façade from PrintClient.
 *   2. There is a `printClient.printLabel({ ... templateKey: 'product_label' })`
 *      call wired into a UI handler.
 *   3. The page renders a "Print label" row action.
 *   4. The missing-device CTA path is still surfaced.
 *   5. The page contains NO raw ZPL strings (defense-in-depth alongside the
 *      `no-raw-zpl-outside-printing` ESLint rule).
 *   6. The page does NOT reach around the seam into raw drivers, POS hooks,
 *      hardwareClient, or the internal `printLabelByTemplate` primitive.
 *
 * Source-inspection rather than a render test — Products has dozens of
 * unrelated hook imports whose mocks would dwarf the assertion.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PRODUCTS = resolve(__dirname, "../../pages/Products.tsx");
const SRC = readFileSync(PRODUCTS, "utf-8");

describe("Products label-print seam (Wave B2.2)", () => {
  it("imports the platform-hardware seam hook for the missing-device CTA", () => {
    expect(SRC).toContain(
      'from "@/hooks/inventory/useInventoryLabelPrinter"',
    );
    expect(SRC).toMatch(/useInventoryLabelPrinter\s*\(\s*\)/);
  });

  it("imports the printClient façade (single-chokepoint label entry)", () => {
    expect(SRC).toContain('from "@/services/printing/PrintClient"');
    expect(SRC).toMatch(/printClient\.printLabel\s*\(/);
  });

  it("uses the canonical product_label template key", () => {
    expect(SRC).toMatch(/templateKey:\s*["']product_label["']/);
  });

  it("does NOT reach around the façade into the labelDispatch primitive or raw drivers/hardwareClient/POS hooks", () => {
    expect(SRC).not.toMatch(/from\s+["']@\/services\/hardware\/drivers\//);
    expect(SRC).not.toMatch(/from\s+["']@\/hooks\/pos\/useHardware/);
    expect(SRC).not.toMatch(/hardwareClient\./);
    expect(SRC).not.toMatch(/printLabelByTemplate\s*\(/);
    expect(SRC).not.toMatch(/from\s+["']@\/services\/printing\/labelDispatch["']/);
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
