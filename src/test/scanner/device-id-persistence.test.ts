/**
 * Device-id persistence — Plan P4a.
 *
 * Locks: phone refresh MUST NOT burn the device id. Migration from the
 * legacy `sessionStorage` key carries the existing identity forward
 * AND emits the `refresh_burned_token` marker so we can observe the
 * historical bug fading in telemetry.
 */
import { describe, it, expect } from "vitest";
import {
  resolveDeviceId,
  DEVICE_ID_KEY,
  LEGACY_SESSION_KEY,
  type StorageLike,
} from "@/services/scanner/deviceIdentity";

function makeStorage(initial: Record<string, string> = {}): StorageLike & { _data: Record<string, string> } {
  const data: Record<string, string> = { ...initial };
  return {
    _data: data,
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = v; },
  };
}

describe("resolveDeviceId", () => {
  it("returns existing localStorage id without touching anything", () => {
    const local = makeStorage({ [DEVICE_ID_KEY]: "existing-id" });
    const session = makeStorage();
    const res = resolveDeviceId(local, session);
    expect(res).toEqual({ id: "existing-id", source: "local", refreshBurnedToken: false });
    expect(session._data).toEqual({});
  });

  it("migrates legacy sessionStorage value to localStorage and flags burned token", () => {
    const local = makeStorage();
    const session = makeStorage({ [LEGACY_SESSION_KEY]: "legacy-id" });
    const res = resolveDeviceId(local, session);
    expect(res.id).toBe("legacy-id");
    expect(res.source).toBe("migrated");
    expect(res.refreshBurnedToken).toBe(true);
    expect(local._data[DEVICE_ID_KEY]).toBe("legacy-id");
  });

  it("generates a new id and writes to both stores when nothing exists", () => {
    const local = makeStorage();
    const session = makeStorage();
    const res = resolveDeviceId(local, session);
    expect(res.id).toMatch(/[a-z0-9-]+/i);
    expect(res.source).toBe("new");
    expect(res.refreshBurnedToken).toBe(false);
    expect(local._data[DEVICE_ID_KEY]).toBe(res.id);
    expect(session._data[LEGACY_SESSION_KEY]).toBe(res.id);
  });

  it("is idempotent across calls (simulates refresh)", () => {
    const local = makeStorage();
    const session = makeStorage();
    const first = resolveDeviceId(local, session);
    const second = resolveDeviceId(local, session);
    expect(second.id).toBe(first.id);
    expect(second.source).toBe("local");
    expect(second.refreshBurnedToken).toBe(false);
  });

  it("localStorage value wins over legacy sessionStorage value (no double-migration)", () => {
    const local = makeStorage({ [DEVICE_ID_KEY]: "canonical" });
    const session = makeStorage({ [LEGACY_SESSION_KEY]: "legacy" });
    const res = resolveDeviceId(local, session);
    expect(res.id).toBe("canonical");
    expect(res.source).toBe("local");
  });
});
