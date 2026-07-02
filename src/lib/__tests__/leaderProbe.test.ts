/**
 * Tests for leaderProbe.
 *
 * Scenarios covered (the multi-tab races + stale-metadata recovery the
 * onboarding plan calls out):
 *   1. No leader entries → guards do not defer.
 *   2. Fresh leader entry from another tab → guards defer.
 *   3. Stale leader entry (heartbeat older than freshness window) → guards
 *      do NOT defer (treats it as a crashed leader so the user is never
 *      held hostage by an abandoned tab).
 *   4. Multiple sagas in flight → presence of any fresh entry wins.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  hasActiveOnboardingLeader,
  shouldDeferForOnboardingLeader,
} from "../onboarding/leaderProbe";

const KEY_PREFIX = "ls_onboarding_leader:";

function setLeader(idemKey: string, ageMs: number, tabId = "tab-other") {
  localStorage.setItem(
    KEY_PREFIX + idemKey,
    JSON.stringify({ tabId, ts: Date.now() - ageMs }),
  );
}

describe("leaderProbe", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns false when no onboarding leader entries exist", () => {
    expect(hasActiveOnboardingLeader()).toBe(false);
    expect(shouldDeferForOnboardingLeader()).toBe(false);
  });

  it("returns true for a fresh sibling-tab leader", () => {
    setLeader("idem-1", 500);
    expect(hasActiveOnboardingLeader()).toBe(true);
    expect(shouldDeferForOnboardingLeader()).toBe(true);
  });

  it("ignores a stale leader entry (treated as crashed)", () => {
    // 30s old — well past the 10s freshness window.
    setLeader("idem-1", 30_000);
    expect(hasActiveOnboardingLeader()).toBe(false);
  });

  it("ignores malformed entries without crashing", () => {
    localStorage.setItem(KEY_PREFIX + "idem-bad", "not-json");
    expect(() => hasActiveOnboardingLeader()).not.toThrow();
    expect(hasActiveOnboardingLeader()).toBe(false);
  });

  it("returns true if any one of multiple entries is fresh", () => {
    setLeader("idem-old", 30_000);
    setLeader("idem-new", 100);
    expect(hasActiveOnboardingLeader()).toBe(true);
  });

  it("ignores keys outside the onboarding leader namespace", () => {
    localStorage.setItem(
      "unrelated_key",
      JSON.stringify({ tabId: "x", ts: Date.now() }),
    );
    expect(hasActiveOnboardingLeader()).toBe(false);
  });
});
