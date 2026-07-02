import { describe, it, expect } from "vitest";
import { getReplenishmentSignal } from "../replenishmentSignal";

describe("getReplenishmentSignal", () => {
  it("returns untracked when inventory tracking is off", () => {
    const s = getReplenishmentSignal({
      trackInventory: false,
      onHand: 100,
      reserved: 0,
      incoming: 0,
      velocityPerWeek: 5,
    });
    expect(s.tier).toBe("untracked");
  });

  it("flags out-of-stock with incoming context", () => {
    const s = getReplenishmentSignal({
      trackInventory: true,
      onHand: 0,
      reserved: 0,
      incoming: 50,
      velocityPerWeek: 10,
    });
    expect(s.tier).toBe("out-of-stock");
    expect(s.hint).toMatch(/incoming/);
  });

  it("classifies critical / low / healthy / overstock by days-of-supply", () => {
    // velocity = 14/wk = 2/day
    const base = { trackInventory: true, reserved: 0, incoming: 0, velocityPerWeek: 14 };
    expect(getReplenishmentSignal({ ...base, onHand: 10 }).tier).toBe("critical"); // 5d
    expect(getReplenishmentSignal({ ...base, onHand: 20 }).tier).toBe("low"); // 10d
    expect(getReplenishmentSignal({ ...base, onHand: 100 }).tier).toBe("healthy"); // 50d
    expect(getReplenishmentSignal({ ...base, onHand: 300 }).tier).toBe("overstock"); // 150d
  });

  it("returns no-velocity when nothing has moved in the window", () => {
    const s = getReplenishmentSignal({
      trackInventory: true,
      onHand: 50,
      reserved: 0,
      incoming: 0,
      velocityPerWeek: 0,
    });
    expect(s.tier).toBe("no-velocity");
    expect(s.daysOfSupply).toBeNull();
  });
});
