/**
 * dialogReadyBus — Plan P5.
 *
 * Locks the DIALOG_READY handshake contract: callers waiting on a
 * scope receive `true` if `signal(scope)` fires before the timeout,
 * `false` otherwise. Multiple waiters on the same scope all fire on
 * a single signal. Signals on an empty scope are no-ops.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { dialogReadyBus } from "@/services/scanner/dialogReadyBus";

describe("dialogReadyBus", () => {
  beforeEach(() => {
    dialogReadyBus._clear();
    vi.useFakeTimers();
  });

  it("resolves true when signal arrives before timeout", async () => {
    const p = dialogReadyBus.waitFor("scope", 1500);
    dialogReadyBus.signal("scope");
    await expect(p).resolves.toBe(true);
  });

  it("resolves false when timeout elapses first", async () => {
    const p = dialogReadyBus.waitFor("scope", 100);
    vi.advanceTimersByTime(101);
    await expect(p).resolves.toBe(false);
  });

  it("fires all waiters on the same scope from a single signal", async () => {
    const a = dialogReadyBus.waitFor("scope");
    const b = dialogReadyBus.waitFor("scope");
    dialogReadyBus.signal("scope");
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
  });

  it("does not cross scopes", async () => {
    const a = dialogReadyBus.waitFor("a", 50);
    dialogReadyBus.signal("b");
    vi.advanceTimersByTime(60);
    await expect(a).resolves.toBe(false);
  });

  it("a signal with no waiters is a no-op (later waiter still times out)", async () => {
    dialogReadyBus.signal("scope");
    const p = dialogReadyBus.waitFor("scope", 50);
    vi.advanceTimersByTime(60);
    await expect(p).resolves.toBe(false);
  });
});
