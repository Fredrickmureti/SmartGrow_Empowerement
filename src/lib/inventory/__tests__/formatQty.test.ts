import { describe, it, expect } from "vitest";
import {
  formatBaseQty,
  formatQtyAsPacks,
  formatQtyWithPacks,
  decomposeQty,
} from "../formatQty";

const packs = [
  { name: "Box", qty_in_base_uom: 24 },
  { name: "Pack", qty_in_base_uom: 6 },
];

describe("formatQty", () => {
  it("formats base qty with label", () => {
    expect(formatBaseQty(12, "ea")).toBe("12 ea");
    expect(formatBaseQty(0, "ea")).toBe("0 ea");
  });

  it("rolls into largest pack with remainder", () => {
    expect(formatQtyAsPacks(50, packs, "ea")).toBe("2 Box + 2 ea");
    expect(formatQtyAsPacks(48, packs, "ea")).toBe("2 Box");
    expect(formatQtyAsPacks(6, packs, "ea")).toBe("1 Pack");
    expect(formatQtyAsPacks(5, packs, "ea")).toBe("5 ea");
  });

  it("combined display falls back to base when no pack fits", () => {
    expect(formatQtyWithPacks(5, packs, "ea")).toBe("5 ea");
    expect(formatQtyWithPacks(240, packs, "ea")).toBe("10 Box (240 ea)");
    expect(formatQtyWithPacks(0, packs, "ea")).toBe("0 ea");
    expect(formatQtyWithPacks(10, [], "ea")).toBe("10 ea");
  });

  it("decomposes across multiple packs", () => {
    const parts = decomposeQty(75, packs, "ea");
    expect(parts).toEqual([
      { name: "Box", count: 3 },
      { name: "Pack", count: 0 },
      { name: "ea", count: 3 },
    ]);
  });
});
