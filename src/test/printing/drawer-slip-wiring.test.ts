/**
 * Phase B1 / Phase C — Cash-drawer audit-slip wiring contract.
 *
 * SOX/PCI evidence: every out-of-band cash-drawer open must produce a
 * paper slip. This test locks the two ends of the seam so a future
 * refactor can't silently sever the audit trail:
 *
 *   1. `usePOSCashDrawer` dispatches `drawer_slip` via `printClient`
 *      (not the preview dialog, not a raw ESC/POS byte buffer, not the
 *      hardwareClient shim).
 *   2. `generate-document` has a `drawer_slip` fetcher AND a matching
 *      short-circuit that renders through `_shared/escpos/drawer.ts`.
 *   3. The rendering-ownership rule (ADR-0085) still holds: the drawer
 *      builder is the sole owner of drawer-slip bytes; the app never
 *      hand-rolls them.
 *
 * Source-inspection rather than a render test — the hook has a heavy
 * mutation graph that would drown the assertion.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = (p: string) => resolve(__dirname, "../../../", p);

describe("Cash-drawer audit slip wiring (Phase B1)", () => {
  const HOOK = readFileSync(R("src/hooks/pos/usePOSCashDrawer.ts"), "utf-8");
  const EDGE = readFileSync(R("supabase/functions/generate-document/index.ts"), "utf-8");
  const BUILDER = readFileSync(R("supabase/functions/_shared/escpos/drawer.ts"), "utf-8");

  it("usePOSCashDrawer dispatches drawer_slip via printClient", () => {
    expect(HOOK).toMatch(/from ["']@\/services\/printing\/PrintClient["']/);
    expect(HOOK).toMatch(/documentType:\s*["']drawer_slip["']/);
    expect(HOOK).toMatch(/intent:\s*["']receipt["']/);
  });

  it("dispatch is fire-and-forget (never blocks the cash movement)", () => {
    // `.catch(` on the print call — a thrown printer error must not
    // roll back or re-surface as an onError toast on the mutation.
    expect(HOOK).toMatch(/printClient\.print\([^)]*\)[\s\S]{0,400}\.catch\(/);
  });

  it("hook does NOT reach around the seam to raw bytes or hardwareClient", () => {
    expect(HOOK).not.toMatch(/hardwareClient\./);
    expect(HOOK).not.toMatch(/\x1D\x56/);
    expect(HOOK).not.toMatch(/\[0x1[Bb],\s*0x40\]/);
  });

  it("generate-document registers a drawer_slip fetcher", () => {
    expect(EDGE).toMatch(/drawer_slip:\s*fetchDrawerSlip/);
    expect(EDGE).toMatch(/async function fetchDrawerSlip\(/);
  });

  it("generate-document short-circuits drawer_slip to the shared builder", () => {
    expect(EDGE).toMatch(/documentType === ["']drawer_slip["']/);
    expect(EDGE).toMatch(/buildDrawerSlipEscPos/);
    expect(EDGE).toMatch(/["']\.\.\/_shared\/escpos\/drawer\.ts["']/);
  });

  it("drawer builder emits the enterprise audit fields", () => {
    // Every field auditors expect on a paper drawer slip.
    for (const label of ["Time:", "Register:", "Cashier:", "Amount:", "Signature:"]) {
      expect(BUILDER).toContain(label);
    }
  });

  it("drawer builder is a pure function — no IO imports", () => {
    const runtimeImports = BUILDER.match(/^\s*import\s+(?!type\s)[^;]+;/gm) ?? [];
    expect(runtimeImports).toEqual([]);
  });
});
