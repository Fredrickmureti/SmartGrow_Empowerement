/**
 * Phase A.5 architecture guard — Goods Receipt serial capture.
 *
 * The `enforce_serial_on_movement` trigger (ADR-0067, migration
 * 20260716215647_38a8bb78-…) requires every `stock_movements` row for
 * a serial-tracked product to carry a non-empty `serial_number`, and
 * upserts one row into `stock_serials` per movement. To honour that
 * contract from the receiving side, the GRN wizard must:
 *
 *   1. Fetch per-product tracking flags (batched, one round-trip).
 *   2. Force the operator to enter one unique serial per unit for
 *      every serial-tracked line.
 *   3. Split each serial-tracked receipt line into N single-qty
 *      `goods_receipt_items` rows so downstream stock_movements
 *      inherit exactly one serial each.
 *
 * This guard pins those three properties on the wizard source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "src/features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx"),
  "utf8",
);

describe("Phase A.5 — GRN serial capture", () => {
  it("resolves tracking flags via useProductTrackingFlags", () => {
    expect(src).toMatch(
      /from\s+["']@\/hooks\/useProductTrackingFlags["']/,
    );
    expect(src).toMatch(/useProductTrackingFlags\(/);
  });

  it("carries a per-unit serial_numbers[] on ReceiptLine", () => {
    expect(src).toMatch(/serial_numbers:\s*string\[\]/);
  });

  it("blocks Next / submit when a serial-tracked line is under-captured", () => {
    // Guard: receiveValid gates on `!serialCaptureIncomplete`.
    expect(src).toMatch(/serialCaptureIncomplete/);
    expect(src).toMatch(/!serialCaptureIncomplete/);
  });

  it("rejects duplicate serials in the same line", () => {
    // Uses a Set to enforce uniqueness.
    expect(src).toMatch(/new Set\(cleaned\)/);
  });

  it("splits serial-tracked lines into N single-qty receipt items", () => {
    // The submit expander uses flatMap + qty=1 per serial.
    expect(src).toMatch(/flatMap\(/);
    expect(src).toMatch(/quantity_received:\s*1,/);
  });

  it("keeps the atomic RPC path — no client-side stock_movements insert", () => {
    expect(src).toMatch(/complete_goods_receipt_atomic/);
    expect(src).not.toMatch(/from\("stock_movements"\)\s*\.insert/);
  });
});
