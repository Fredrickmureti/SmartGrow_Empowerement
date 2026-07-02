/**
 * Stage B — receipt snapshot wiring guard.
 *
 * Static checks: the reprint surfaces (preview dialog and edge PDF generator)
 * MUST consult `pos_receipt_snapshots` before falling back to live lookups.
 * If a future agent removes the snapshot read, this test fails loudly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("Stage B — receipt snapshot is consulted on reprint", () => {
  it("ReceiptPreviewDialog imports useReceiptSnapshot and merges snapshot settings", () => {
    const src = read("src/components/pos/ReceiptPreviewDialog.tsx");
    expect(src).toMatch(/useReceiptSnapshot/);
    expect(src).toMatch(/mergeReceiptSettings/);
    // snapshot-derived branding fields must take precedence over the live
    // branding hook
    expect(src).toMatch(/snapBusiness\?\.name/);
  });

  it("generate-document edge function reads pos_receipt_snapshots before live lookup", () => {
    const src = read("supabase/functions/generate-document/index.ts");
    const idx = src.indexOf("pos_receipt_snapshots");
    const liveIdx = src.indexOf('.from("pos_transactions")');
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(liveIdx);
  });

  it("snapshot hook is read-only (no writes / mutations)", () => {
    const src = read("src/hooks/pos/useReceiptSnapshot.ts");
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(|useMutation/);
  });
});