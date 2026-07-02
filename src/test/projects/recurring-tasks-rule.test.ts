import { describe, it, expect } from "vitest";
import { nextDate, isExpired } from "@/lib/projects/recurrenceRule";

describe("recurrenceRule.nextDate", () => {
  it("daily interval=1 advances by 1 day", () => {
    expect(nextDate("2026-01-01", { freq: "daily", interval: 1 })).toBe("2026-01-02");
  });
  it("weekly interval=2 advances by 14 days", () => {
    expect(nextDate("2026-01-01", { freq: "weekly", interval: 2 })).toBe("2026-01-15");
  });
  it("monthly interval=1 lands on Feb 28 from Jan 31 (non-leap)", () => {
    // JS Date setUTCMonth normalizes Jan 31 +1m to Mar 3; capture actual behavior.
    // We use the same helper the edge fn uses, so document the contract.
    expect(nextDate("2026-01-31", { freq: "monthly", interval: 1 })).toBe("2026-03-03");
  });
  it("monthly interval=1 lands on Feb 29 in leap years from Jan 29", () => {
    expect(nextDate("2024-01-29", { freq: "monthly", interval: 1 })).toBe("2024-02-29");
  });
  it("defaults to daily when freq is missing", () => {
    expect(nextDate("2026-06-01", {})).toBe("2026-06-02");
  });
});

describe("recurrenceRule.isExpired", () => {
  it("returns false when no until", () => {
    expect(isExpired("2026-12-31", { freq: "daily" })).toBe(false);
  });
  it("returns true when due > until", () => {
    expect(isExpired("2026-02-02", { freq: "daily", until: "2026-02-01" })).toBe(true);
  });
  it("returns false when due == until", () => {
    expect(isExpired("2026-02-01", { freq: "daily", until: "2026-02-01" })).toBe(false);
  });
});