import { describe, expect, it } from "vitest";
import { quantityForDenomination } from "@/components/products/PackagedQtyCell";

describe("PackagedQtyCell denomination conversion", () => {
  it("shows 100 kg as 2 bags when each bag contains 50 kg", () => {
    expect(quantityForDenomination(100, 50)).toBe(2);
  });

  it("keeps fractional denominations exact", () => {
    expect(quantityForDenomination(17, 50)).toBe(0.34);
  });

  it("falls back safely for an invalid factor", () => {
    expect(quantityForDenomination(100, 0)).toBe(100);
  });
});