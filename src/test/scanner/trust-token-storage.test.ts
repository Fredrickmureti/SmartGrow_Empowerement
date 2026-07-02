/**
 * P4b — trust token storage helpers in `deviceIdentity`.
 *
 * Locks: get/set/clear round-trip; clear is safe on storage shims that
 * only implement get/set (the original `StorageLike` shape did not
 * include `removeItem`).
 */
import { describe, it, expect } from "vitest";
import {
  TRUST_TOKEN_KEY,
  getTrustToken,
  setTrustToken,
  clearTrustToken,
  type StorageLike,
} from "@/services/scanner/deviceIdentity";

function makeStorage(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const s: StorageLike & { _data: Record<string, string> } = {
    _data: data,
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = v; },
    removeItem(k) { delete data[k]; },
  };
  return s;
}

describe("trust token helpers", () => {
  it("round-trips set/get", () => {
    const s = makeStorage();
    expect(getTrustToken(s)).toBeNull();
    setTrustToken("abc123", s);
    expect(getTrustToken(s)).toBe("abc123");
    expect(s._data[TRUST_TOKEN_KEY]).toBe("abc123");
  });

  it("clear removes the token", () => {
    const s = makeStorage({ [TRUST_TOKEN_KEY]: "x" });
    clearTrustToken(s);
    expect(getTrustToken(s)).toBeNull();
  });

  it("clear is safe on shims without removeItem (back-compat)", () => {
    const data: Record<string, string> = { [TRUST_TOKEN_KEY]: "x" };
    const shim: StorageLike & { _data: Record<string, string> } = {
      _data: data,
      getItem(k) { return data[k] ?? null; },
      setItem(k, v) { data[k] = v; },
    };
    clearTrustToken(shim);
    // No throw — and the token is now empty string sentinel.
    expect(shim.getItem(TRUST_TOKEN_KEY)).toBe("");
  });
});