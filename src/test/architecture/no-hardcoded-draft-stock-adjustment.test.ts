/**
 * Architecture guard: stock adjustment routing must go through the
 * `apply_or_request_stock_adjustment` RPC, never through a direct
 * `INSERT ... { status: 'draft' }` from the client.
 *
 * Background: previously `useInventory.ts` hardcoded every adjustment to
 * `status: 'draft'`, forcing every user — including admins — to click a
 * second "Approve" button before stock and GL moved. The fix is the
 * smart-routing RPC which evaluates `approval_rules` server-side and
 * either auto-applies or stores as `pending_approval`.
 *
 * If this file regresses to a hardcoded `'draft'` insert against
 * `stock_adjustments`, this test fails immediately.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const HOOK = fs.readFileSync(
  path.resolve(__dirname, "../../hooks/useInventory.ts"),
  "utf8",
);

describe("Inventory adjustment approval architecture", () => {
  it("uses the smart-routing RPC instead of direct draft inserts", () => {
    expect(HOOK).toContain("apply_or_request_stock_adjustment");
  });

  it("does not hardcode status to 'draft' on stock_adjustments inserts", () => {
    // Find every block that inserts into stock_adjustments and assert it
    // does not also pin status:"draft" in the same insert payload.
    const insertIdx = HOOK.indexOf('.from("stock_adjustments")');
    if (insertIdx === -1) {
      // No direct insert at all — that's the intended state now.
      return;
    }
    // Look at the next ~800 chars after the insert for a status:"draft" line.
    const window = HOOK.slice(insertIdx, insertIdx + 800);
    expect(window).not.toMatch(/status:\s*["']draft["']/);
  });

  it("recognises pending_approval as a valid status in the type union", () => {
    expect(HOOK).toMatch(/status:\s*['"]draft['"]\s*\|\s*['"]pending_approval['"]/);
  });
});
