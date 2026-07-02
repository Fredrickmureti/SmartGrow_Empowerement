/**
 * Regression: when `supabase.auth.signUp` throws a transport-level error
 * (Failed to fetch / ERR_CONNECTION_CLOSED / timeout), the frontend must
 * NOT show "creation failed". It must probe `check-email-availability`
 * to determine the real outcome, and either route to /verify-email
 * (uncertain) or to /login (if the email is verified).
 *
 * This test exercises the classifier path that the SignupForm relies on
 * to make that decision — if it ever regresses, the form will fall back
 * to the misleading "Check your internet connection" toast that produced
 * 7 orphan auth users in one session in the original bug report.
 */
import { describe, it, expect } from "vitest";
import { normalizeError } from "@/services/resilience/ErrorNormalizer";

describe("signup uncertain-outcome classification", () => {
  it("classifies a dropped TCP response as a retry-safe transport kind", () => {
    const dropped = new TypeError("Failed to fetch");
    const n = normalizeError(dropped);
    // The SignupForm checks for these three kinds to trigger the
    // post-failure availability probe instead of toasting an error.
    expect(["offline", "timeout", "server_unavailable"]).toContain(n.kind);
  });

  it("classifies a 5xx as a retry-safe transport kind, not a logic error", () => {
    const n = normalizeError({ status: 503, message: "" });
    expect(["offline", "timeout", "server_unavailable"]).toContain(n.kind);
  });

  it("does NOT classify a 4xx logic error as transport-level", () => {
    const n = normalizeError({ status: 422, message: "User already registered" });
    expect(["offline", "timeout", "server_unavailable"]).not.toContain(n.kind);
  });
});
