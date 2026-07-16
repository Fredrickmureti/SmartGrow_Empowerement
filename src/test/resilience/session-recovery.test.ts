/**
 * Regression coverage for the SessionContext bootstrap state machine.
 *
 * We don't mount the React tree here — instead we exercise the pure
 * primitives (ConnectivityManager + normalizeError) that drive it and
 * assert the invariants the loop depends on. Full component-level
 * coverage lives in the Playwright suite.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { connectivityManager } from "@/services/resilience/ConnectivityManager";
import { normalizeError } from "@/services/resilience/ErrorNormalizer";

const RETRYABLE = new Set(["offline", "timeout", "server_unavailable"]);

describe("session bootstrap invariants", () => {
  beforeEach(() => {
    connectivityManager._resetForTests();
  });

  it("classifies transient failures as retryable and deterministic ones as fatal", () => {
    expect(RETRYABLE.has(normalizeError(new TypeError("Failed to fetch")).kind)).toBe(true);
    expect(RETRYABLE.has(normalizeError({ status: 503, message: "" }).kind)).toBe(true);
    expect(RETRYABLE.has(normalizeError({ status: 403, message: "" }).kind)).toBe(false);
    expect(RETRYABLE.has(normalizeError({ message: "Invalid login credentials" }).kind)).toBe(false);
  });

  it("emits an online transition that a bootstrap loop can subscribe to", () => {
    // Seed offline via reportFailure + navigator-style flip is jsdom-hostile;
    // instead we verify the subscription contract: subscribe fires-once with
    // the current state, then again on transitions.
    const seen: string[] = [];
    connectivityManager.reportFailure();
    connectivityManager.subscribe((s) => seen.push(s));
    // fire-once with current state (degraded after failure)
    expect(seen[0]).toBe("degraded");
    connectivityManager.reportSuccess();
    expect(seen).toContain("online");
  });

  it("auth_expired normalizes to a non-retryable kind that the loop handles specially", () => {
    const n = normalizeError({ status: 401, message: "JWT expired" });
    expect(n.kind).toBe("auth_expired");
    expect(RETRYABLE.has(n.kind)).toBe(false);
    // The bootstrap loop does NOT count this against the retry budget — it
    // triggers a one-shot supabase.auth.refreshSession() then loops. That
    // behaviour is asserted in SessionContext directly; here we only
    // assert the classification the loop keys off.
  });

  it("never surfaces raw error.message through the normalized catalog", () => {
    const raw = "connect ECONNREFUSED 127.0.0.1:54321";
    const n = normalizeError(new Error(raw));
    expect(n.message).not.toContain(raw);
    expect(n.title.length).toBeGreaterThan(0);
  });
});
