/**
 * Phase 6 (ADR 0105 §8) — the pack station must convert whatever the bound
 * scale driver reports into kilograms before it reaches `seal_pack_carton`,
 * because dim-weight billing and carrier admissibility read that number.
 */
import { describe, it, expect } from "vitest";
import { normalizeScaleWeight } from "@/features/warehouse/packaging/usePackScale";

describe("normalizeScaleWeight", () => {
  it("passes kilograms through", () => {
    expect(normalizeScaleWeight({ weight: 2.5, unit: "kg", stable: true }))
      .toMatchObject({ kg: 2.5, stable: true });
  });

  it("converts grams, pounds and ounces", () => {
    expect(normalizeScaleWeight({ weight: 1500, unit: "g" })?.kg).toBe(1.5);
    expect(normalizeScaleWeight({ weight: 10, unit: "lb" })?.kg).toBeCloseTo(4.536, 3);
    expect(normalizeScaleWeight({ weight: 16, unit: "oz" })?.kg).toBeCloseTo(0.454, 3);
  });

  it("accepts the router's grams envelope", () => {
    expect(normalizeScaleWeight({ grams: 2400 })?.kg).toBe(2.4);
  });

  it("propagates instability instead of hiding it", () => {
    expect(normalizeScaleWeight({ weight: 3, unit: "kg", stable: false })?.stable).toBe(false);
  });

  it("returns null for unusable payloads", () => {
    expect(normalizeScaleWeight(null)).toBeNull();
    expect(normalizeScaleWeight({ unit: "kg" })).toBeNull();
    expect(normalizeScaleWeight({ weight: Number.NaN, unit: "kg" })).toBeNull();
  });
});
