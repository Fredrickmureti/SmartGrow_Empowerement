import { describe, it, expect, beforeEach, vi } from "vitest";
import { connectivityManager } from "@/services/resilience/ConnectivityManager";
import { safeQuery, safeQueryRetry } from "@/services/resilience/supabaseSafe";

describe("safeQuery", () => {
  beforeEach(() => connectivityManager._resetForTests());

  it("short-circuits to offline kind when manager already offline", async () => {
    // Simulate offline.
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    connectivityManager._resetForTests();
    connectivityManager.init();

    const builder = Promise.resolve({ data: null, error: null });
    const { data, error } = await safeQuery(builder);
    expect(data).toBeNull();
    expect(error?.kind).toBe("offline");

    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("returns data and reports success when query resolves cleanly", async () => {
    const success = vi.spyOn(connectivityManager, "reportSuccess");
    const builder = Promise.resolve({ data: { ok: 1 }, error: null });
    const { data, error } = await safeQuery(builder);
    expect(data).toEqual({ ok: 1 });
    expect(error).toBeNull();
    expect(success).toHaveBeenCalled();
  });

  it("normalizes a thrown TypeError as offline and reports failure", async () => {
    const fail = vi.spyOn(connectivityManager, "reportFailure");
    const builder = Promise.reject(new TypeError("Failed to fetch"));
    const { error } = await safeQuery(builder);
    expect(error?.kind).toBe("offline");
    expect(fail).toHaveBeenCalled();
  });

  it("times out a hung builder and normalizes to kind: 'timeout'", async () => {
    const builder = new Promise<{ data: null; error: null }>(() => { /* never resolves */ });
    const { error } = await safeQuery(builder, { timeoutMs: 30 });
    expect(error?.kind).toBe("timeout");
  });
});

describe("safeQueryRetry", () => {
  beforeEach(() => connectivityManager._resetForTests());

  it("retries on transient TypeError and succeeds", async () => {
    let attempts = 0;
    const factory = () => {
      attempts += 1;
      if (attempts < 2) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ data: { ok: true }, error: null });
    };
    const { data, error } = await safeQueryRetry(factory, { maxRetries: 2, baseDelayMs: 1 });
    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("does NOT retry on non-retryable kinds (e.g. permission_denied)", async () => {
    let attempts = 0;
    const factory = () => {
      attempts += 1;
      return Promise.resolve({ data: null, error: { status: 403, message: "permission denied" } as unknown });
    };
    const { error } = await safeQueryRetry(factory, { maxRetries: 3, baseDelayMs: 1 });
    expect(error?.kind).toBe("permission_denied");
    expect(attempts).toBe(1);
  });
});
