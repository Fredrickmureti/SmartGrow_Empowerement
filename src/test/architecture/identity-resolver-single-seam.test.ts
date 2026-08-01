/**
 * Architecture guard — Phase C of the product identification plan.
 *
 * Operational capture surfaces (WMS receiving / picking / counts, the
 * goods-receipt wizard, stock transfers) must resolve product identity ONLY
 * through the canonical `resolve_product_identity` seam:
 *
 *   useResolveProductIdentity  (client hook)
 *   useWmsIdentityGate         (WMS wrapper, adds block-the-line feedback)
 *   pos_resolve_barcode        (POS, delegates to the same SQL resolver)
 *
 * They must never hand-roll a `product_identifiers` query: that path skips
 * packaging-level conversion, GS1 handling, the tenant gate and the
 * ambiguity signal — which is exactly the drift this phase removed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

/** Capture surfaces cut over in C2–C5. */
const CUTOVER_FILES = [
  "pages/warehouse/ReceivingSessions.tsx",
  "pages/warehouse/PickList.tsx",
  "pages/inventory/PhysicalCount.tsx",
  "pages/inventory/TransferNew.tsx",
  "features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx",
];

function read(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf8");
}

describe("Phase C — canonical identity resolver is the only seam", () => {
  it.each(CUTOVER_FILES)("%s does not query product_identifiers directly", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/from\(\s*["']product_identifiers["']\s*\)/);
    expect(src).not.toMatch(/code_norm/);
  });

  it.each(CUTOVER_FILES)("%s no longer uses the POS barcode resolver", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/useResolveBarcode/);
  });

  it.each(CUTOVER_FILES)("%s resolves through the canonical hook", (rel) => {
    const src = read(rel);
    const usesHook =
      /useResolveProductIdentity/.test(src) || /useWmsIdentityGate/.test(src);
    expect(usesHook).toBe(true);
  });

  it("the canonical hook is the only client caller of resolve_product_identity", () => {
    const hook = read("hooks/inventory/useResolveProductIdentity.ts");
    expect(hook).toMatch(/resolve_product_identity/);
    for (const rel of CUTOVER_FILES) {
      // Only comments may mention the RPC — no direct invocation.
      expect(read(rel)).not.toMatch(/rpc\(\s*["']resolve_product_identity["']/);
    }
  });

  it("the WMS gate blocks the line instead of only toasting", () => {
    const gate = read("features/warehouse/scanning/useWmsIdentityGate.ts");
    // Rejections must go through scanFeedbackBus (audio + haptic) and
    // return null so the caller cannot post stock.
    expect(gate).toMatch(/scanFeedbackBus\.emit/);
    expect(gate).toMatch(/return null/);
    expect(gate).not.toMatch(/\btoast\s*\(|\btoast\.(error|success|warning)\s*\(/);
  });
});
