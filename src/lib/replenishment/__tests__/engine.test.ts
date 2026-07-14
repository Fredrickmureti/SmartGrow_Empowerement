import { describe, it, expect } from "vitest";
import {
  computeRecommendation,
  classifyUrgency,
  roundToOrderQty,
  planReplenishment,
  type EngineRuleInput,
} from "../engine";

function rule(overrides: Partial<EngineRuleInput> = {}): EngineRuleInput {
  return {
    productId: "p1",
    branchId: "b1",
    safetyStock: 0,
    leadTimeDays: 7,
    moq: 0,
    packSize: 1,
    preferredVendorId: null,
    reorderPoint: 0,
    onHand: 0,
    reserved: 0,
    incoming: 0,
    velocityPerWeek: 0,
    ...overrides,
  };
}

describe("roundToOrderQty", () => {
  it("returns 0 for non-positive qty", () => {
    expect(roundToOrderQty(0, 5, 6)).toBe(0);
    expect(roundToOrderQty(-3, 5, 6)).toBe(0);
  });
  it("rounds up to pack size", () => {
    expect(roundToOrderQty(11, 0, 6)).toBe(12);
    expect(roundToOrderQty(13, 0, 6)).toBe(18);
  });
  it("respects MOQ floor", () => {
    expect(roundToOrderQty(4, 20, 6)).toBe(20);
  });
  it("treats packSize=0 as 1", () => {
    expect(roundToOrderQty(4.2, 0, 0)).toBe(5);
  });
});

describe("classifyUrgency", () => {
  it("stockout when available <= 0", () => {
    expect(classifyUrgency(0, 10)).toBe("stockout");
    expect(classifyUrgency(-5, 10)).toBe("stockout");
  });
  it("planned when no velocity", () => {
    expect(classifyUrgency(50, 0)).toBe("planned");
  });
  it("critical below 7 days of supply", () => {
    // 14/wk = 2/day; 10 units → 5 days
    expect(classifyUrgency(10, 14)).toBe("critical");
  });
  it("low between 7 and 14 days", () => {
    // 14/wk = 2/day; 20 units → 10 days
    expect(classifyUrgency(20, 14)).toBe("low");
  });
  it("planned above 14 days", () => {
    expect(classifyUrgency(100, 14)).toBe("planned");
  });
});

describe("computeRecommendation", () => {
  it("nets available, incoming, safety and lead-time demand", () => {
    const r = computeRecommendation(rule({
      onHand: 20, reserved: 5, incoming: 10,
      velocityPerWeek: 14, leadTimeDays: 7, safetyStock: 5,
    }));
    // available=15, lead demand = 2/d * 7 = 14, need = max(0, 5+14-15-10) = 0
    expect(r.netRequirement).toBe(0);
    // available/day = 2 → 7.5d cover → low
    expect(r.urgency).toBe("low");
  });

  it("computes a positive need when incoming is insufficient", () => {
    const r = computeRecommendation(rule({
      onHand: 5, reserved: 0, incoming: 0,
      velocityPerWeek: 14, leadTimeDays: 14, safetyStock: 10,
      moq: 0, packSize: 1,
    }));
    // lead demand = 2/d * 14 = 28; need = max(0, 10+28-5-0) = 33
    expect(r.netRequirement).toBe(33);
    expect(r.suggestedQty).toBe(33);
  });

  it("rounds suggested qty to pack size and MOQ", () => {
    const r = computeRecommendation(rule({
      onHand: 0, velocityPerWeek: 21, leadTimeDays: 7, safetyStock: 0,
      moq: 50, packSize: 12,
    }));
    // lead demand = 3/d * 7 = 21; need = 21; ceil(21/12)*12 = 24; max(50,24)=50
    expect(r.suggestedQty).toBe(50);
    expect(r.urgency).toBe("stockout");
  });
});

describe("planReplenishment", () => {
  it("keeps stockouts even when net need is zero", () => {
    const out = planReplenishment([
      rule({ productId: "a", onHand: 0, velocityPerWeek: 0 }),
      rule({ productId: "b", onHand: 100, velocityPerWeek: 0 }),
    ]);
    expect(out.map((r) => r.productId)).toEqual(["a"]);
  });
});