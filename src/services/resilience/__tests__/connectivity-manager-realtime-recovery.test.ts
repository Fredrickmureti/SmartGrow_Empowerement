/**
 * Regression: realtime-degraded gate must not stick on after
 * connectivity recovery, and `closed` must observe the same grace
 * window as `channel_error`/`timed_out`.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { connectivityManager } from "../ConnectivityManager";

describe("ConnectivityManager — realtime recovery", () => {
  beforeEach(() => {
    connectivityManager._resetForTests();
    connectivityManager.init();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("clears the realtime-degraded gate when connectivity returns to online", () => {
    connectivityManager.reportRealtimeState("channel_error");
    vi.advanceTimersByTime(6_000);
    expect(connectivityManager.isRealtimeDegraded()).toBe(true);

    // Simulate a real network drop + recovery.
    connectivityManager.reportFailure();        // → degraded
    // Transition to offline then back online via the public probe path:
    // calling reportSuccess() from degraded promotes to online and must
    // collapse the realtime gate.
    connectivityManager.reportSuccess();

    expect(connectivityManager.isRealtimeDegraded()).toBe(false);
    expect(connectivityManager.getRealtimeState()).toBe("unknown");
  });

  it("treats `closed` with the same grace window as channel_error", () => {
    connectivityManager.reportRealtimeState("closed");
    // Immediately after the first non-subscribed report, gate is not on.
    expect(connectivityManager.isRealtimeDegraded()).toBe(false);
    vi.advanceTimersByTime(4_000);
    expect(connectivityManager.isRealtimeDegraded()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(connectivityManager.isRealtimeDegraded()).toBe(true);
  });

  it("short closed→subscribed flips inside the grace window never report degraded", () => {
    connectivityManager.reportRealtimeState("closed");
    vi.advanceTimersByTime(1_000);
    connectivityManager.reportRealtimeState("subscribed");
    expect(connectivityManager.isRealtimeDegraded()).toBe(false);
    connectivityManager.reportRealtimeState("closed");
    vi.advanceTimersByTime(2_000);
    connectivityManager.reportRealtimeState("subscribed");
    expect(connectivityManager.isRealtimeDegraded()).toBe(false);
  });
});
