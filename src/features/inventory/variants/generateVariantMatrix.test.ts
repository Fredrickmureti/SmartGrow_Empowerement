import { describe, it, expect } from "vitest";
import {
  generateVariantMatrix,
  deriveVariantSku,
  sameCoord,
} from "./generateVariantMatrix";

describe("generateVariantMatrix", () => {
  it("returns empty for no axes", () => {
    expect(generateVariantMatrix([])).toEqual([]);
  });

  it("returns empty when every axis has no values", () => {
    expect(
      generateVariantMatrix([
        { axisName: "Size", values: [] },
        { axisName: "Colour", values: [] },
      ]),
    ).toEqual([]);
  });

  it("expands a single axis", () => {
    expect(
      generateVariantMatrix([{ axisName: "Size", values: ["S", "M", "L"] }]),
    ).toEqual([{ Size: "S" }, { Size: "M" }, { Size: "L" }]);
  });

  it("cartesian-multiplies two axes", () => {
    const result = generateVariantMatrix([
      { axisName: "Size", values: ["S", "M"] },
      { axisName: "Colour", values: ["Red", "Blue"] },
    ]);
    expect(result).toHaveLength(4);
    expect(result).toContainEqual({ Size: "S", Colour: "Red" });
    expect(result).toContainEqual({ Size: "M", Colour: "Blue" });
  });

  it("skips empty axes in the product", () => {
    const result = generateVariantMatrix([
      { axisName: "Size", values: ["S"] },
      { axisName: "Colour", values: [] },
    ]);
    expect(result).toEqual([{ Size: "S" }]);
  });
});

describe("deriveVariantSku", () => {
  it("appends slugified axis values in stable axis order", () => {
    expect(deriveVariantSku("SHIRT", { Size: "M", Colour: "Red" })).toBe(
      "SHIRT-RED-M",
    );
  });
  it("falls back to VAR when parent has no SKU", () => {
    expect(deriveVariantSku(null, { Size: "S" })).toBe("VAR-S");
  });
  it("strips diacritics and non-alphanumerics", () => {
    expect(deriveVariantSku("P", { Colour: "Café Noir" })).toBe("P-CAFENOIR");
  });
});

describe("sameCoord", () => {
  it("matches equal coords regardless of key order", () => {
    expect(sameCoord({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
  });
  it("rejects different values", () => {
    expect(sameCoord({ a: "1" }, { a: "2" })).toBe(false);
  });
  it("rejects null / mismatched shapes", () => {
    expect(sameCoord(null, { a: "1" })).toBe(false);
    expect(sameCoord({ a: "1" }, { a: "1", b: "2" })).toBe(false);
  });
});
