/**
 * Reference engine tests (ADR 0108) — hierarchy precedence, projection maths,
 * pack rounding, FEFO source choice, idempotency and health tiering.
 */
import { describe, it, expect } from "vitest";
import {
  resolveEffectiveRule,
  projectPickFace,
  roundToPack,
  chooseSource,
  planPickFace,
  minutesToStockout,
  pickFaceHealth,
  type ReplenRule,
  type PickFaceContext,
} from "../engine";

const base: Omit<ReplenRule, "id" | "scope"> = {
  strategy: "min_max",
  warehouseId: "w1",
  minQty: 10,
  maxQty: 50,
  packMultiple: 6,
  priority: 5,
  isActive: true,
};

const ctx: PickFaceContext = {
  warehouseId: "w1",
  pickLocationId: "pf1",
  productId: "p1",
  categoryId: "c1",
  zoneLocationId: "z1",
  onHand: 4,
};

describe("resolveEffectiveRule", () => {
  const rules: ReplenRule[] = [
    { ...base, id: "r-wh", scope: "warehouse" },
    { ...base, id: "r-zone", scope: "zone", zoneLocationId: "z1" },
    { ...base, id: "r-cat", scope: "category", categoryId: "c1" },
    { ...base, id: "r-prod", scope: "product", productId: "p1" },
    { ...base, id: "r-face", scope: "pick_face", pickLocationId: "pf1" },
  ];

  it("prefers the most specific scope", () => {
    expect(resolveEffectiveRule(rules, ctx)?.id).toBe("r-face");
    expect(resolveEffectiveRule(rules.slice(0, 4), ctx)?.id).toBe("r-prod");
    expect(resolveEffectiveRule(rules.slice(0, 3), ctx)?.id).toBe("r-cat");
    expect(resolveEffectiveRule(rules.slice(0, 2), ctx)?.id).toBe("r-zone");
    expect(resolveEffectiveRule(rules.slice(0, 1), ctx)?.id).toBe("r-wh");
  });

  it("lets an emergency rule beat a more specific normal rule", () => {
    const withEmergency = [...rules, { ...base, id: "r-emg", scope: "zone" as const, zoneLocationId: "z1", isEmergency: true }];
    expect(resolveEffectiveRule(withEmergency, ctx)?.id).toBe("r-emg");
  });

  it("honours effective-date windows and velocity class filters", () => {
    const at = new Date("2026-06-01T00:00:00Z");
    const expired = [{ ...base, id: "r-old", scope: "pick_face" as const, pickLocationId: "pf1", effectiveTo: "2026-01-01" }];
    expect(resolveEffectiveRule(expired, ctx, at)).toBeNull();

    const velocity = [{ ...base, id: "r-a", scope: "warehouse" as const, velocityClass: "A" }];
    expect(resolveEffectiveRule(velocity, ctx, at)).toBeNull();
    expect(resolveEffectiveRule(velocity, { ...ctx, velocityClass: "A" }, at)?.id).toBe("r-a");
  });

  it("ignores inactive rules and other warehouses", () => {
    expect(resolveEffectiveRule([{ ...base, id: "x", scope: "warehouse", isActive: false }], ctx)).toBeNull();
    expect(resolveEffectiveRule([{ ...base, id: "x", scope: "warehouse", warehouseId: "w2" }], ctx)).toBeNull();
  });
});

describe("projection and rounding", () => {
  it("nets allocations and blocked stock, adds in-flight refill", () => {
    expect(projectPickFace({ ...ctx, onHand: 40, allocated: 12, blocked: 3, inbound: 6 })).toBe(31);
  });

  it("rounds up to the pack multiple", () => {
    expect(roundToPack(41, 6)).toBe(42);
    expect(roundToPack(0, 6)).toBe(0);
    expect(roundToPack(7, 0)).toBe(7);
  });
});

describe("chooseSource", () => {
  it("picks the earliest expiry and explains rejections", () => {
    const res = chooseSource(
      [
        { locationId: "L1", available: 100, expiryDate: "2026-12-01", lotNumber: "A" },
        { locationId: "L2", available: 100, expiryDate: "2026-07-01", lotNumber: "B" },
        { locationId: "L3", available: 100, blocked: true, lotNumber: "C" },
        { locationId: "L4", available: 0, lotNumber: "D" },
      ],
      42,
    );
    expect(res.chosen?.locationId).toBe("L2");
    expect(res.rejected.find((r) => r.locationId === "L3")?.reason).toBe("blocked");
    expect(res.rejected.find((r) => r.locationId === "L4")?.reason).toBe("no_stock");
  });

  it("prefers the biggest quantity when no expiry is tracked", () => {
    const res = chooseSource(
      [
        { locationId: "L1", available: 5 },
        { locationId: "L2", available: 80 },
      ],
      10,
    );
    expect(res.chosen?.locationId).toBe("L2");
  });

  it("returns no source when nothing is eligible", () => {
    expect(chooseSource([{ locationId: "L1", available: 0 }], 5).chosen).toBeNull();
  });
});

describe("planPickFace", () => {
  const faceRule: ReplenRule = { ...base, id: "r1", scope: "pick_face", pickLocationId: "pf1", targetQty: 48 };
  const candidates = [{ locationId: "S1", available: 500, expiryDate: "2026-09-01", lotNumber: "L-1" }];

  it("plans a rounded quantity from the FEFO source", () => {
    const out = planPickFace([faceRule], { ...ctx, onHand: 4 }, candidates);
    expect(out.kind).toBe("planned");
    if (out.kind !== "planned") return;
    expect(out.item.requestedQty).toBe(48); // 48 - 4 = 44, rounded up to the pack multiple of 6
    expect(out.item.sourceLocationId).toBe("S1");
    expect(out.item.lotNumber).toBe("L-1");
    expect(out.item.trace.reasonCode).toBe("ok");
  });

  it("skips a face that is above threshold", () => {
    const out = planPickFace([faceRule], { ...ctx, onHand: 30 }, candidates);
    expect(out).toMatchObject({ kind: "skipped", reasonCode: "above_threshold" });
  });

  it("is idempotent while an order is open", () => {
    const out = planPickFace([faceRule], { ...ctx, hasOpenOrder: true }, candidates);
    expect(out).toMatchObject({ kind: "skipped", reasonCode: "open_order" });
  });

  it("skips with no_rule and manual_only", () => {
    expect(planPickFace([], ctx, candidates)).toMatchObject({ reasonCode: "no_rule" });
    expect(
      planPickFace([{ ...faceRule, strategy: "manual" }], ctx, candidates),
    ).toMatchObject({ reasonCode: "manual_only" });
  });

  it("records rejected candidates when no source is usable", () => {
    const out = planPickFace([faceRule], ctx, [{ locationId: "S9", available: 0 }]);
    expect(out.kind).toBe("skipped");
    if (out.kind !== "skipped") return;
    expect(out.reasonCode).toBe("no_source");
    expect(out.trace.rejectedSources[0]).toMatchObject({ locationId: "S9", reason: "no_stock" });
  });

  it("clamps the request to what the source can give", () => {
    const out = planPickFace([faceRule], { ...ctx, onHand: 0 }, [{ locationId: "S1", available: 20 }]);
    expect(out.kind).toBe("planned");
    if (out.kind !== "planned") return;
    expect(out.item.requestedQty).toBe(18); // floor(20/6)*6
  });
});

describe("health tiering", () => {
  it("derives minutes to stockout and a tier", () => {
    expect(minutesToStockout(10, 20)).toBe(30);
    expect(minutesToStockout(10, 0)).toBeNull();
    expect(pickFaceHealth(null, 0)).toBe("stockout");
    expect(pickFaceHealth(10, 5)).toBe("critical");
    expect(pickFaceHealth(90, 50)).toBe("low");
    expect(pickFaceHealth(600, 500)).toBe("healthy");
  });
});
