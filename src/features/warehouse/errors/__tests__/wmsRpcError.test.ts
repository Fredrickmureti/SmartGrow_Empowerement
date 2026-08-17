import { describe, it, expect } from "vitest";
import { toWmsFailure, wmsErrorCode, WmsRpcError } from "../wmsRpcError";

/** The exact shape PostgREST hands back for a RAISEd exception. */
const postgrest = (message: string) => ({
  message,
  details: null,
  hint: null,
  code: "P0001",
});

describe("wmsRpcError", () => {
  it("never renders [object Object] for a plain PostgREST rejection", () => {
    const failure = toWmsFailure(postgrest("boom"), "Close failed");
    expect(failure.message).not.toContain("[object Object]");
    expect(failure.message.length).toBeGreaterThan(0);
  });

  it("classifies a coded business-rule rejection from a plain object", () => {
    const failure = toWmsFailure(postgrest("WMS_SCAN_SHORTAGE: 2 cartons unscanned"));
    expect(failure.code).toBe("WMS_SCAN_SHORTAGE");
    expect(failure.kind).toBe("business_rule");
    expect(failure.retryable).toBe(false);
    expect(failure.description).toBeTruthy();
  });

  it("classifies proof and carrier gates on the dispatch edge", () => {
    expect(toWmsFailure(postgrest("WMS_PROOF_REQUIRED")).kind).toBe("business_rule");
    expect(toWmsFailure(postgrest("WMS_NO_CARRIER")).kind).toBe("business_rule");
  });

  it("treats stale row versions as concurrency, coded or textual", () => {
    expect(toWmsFailure(postgrest("WMS_LPN_VERSION_CONFLICT")).kind).toBe("concurrency");
    expect(toWmsFailure(new Error("Row version mismatch")).kind).toBe("concurrency");
  });

  it("reads the code out of a WmsRpcError as well as a raw object", () => {
    const wrapped = new WmsRpcError("close_loading_manifest", postgrest("WMS_SCAN_SHORTAGE"));
    expect(wrapped).toBeInstanceOf(Error);
    expect(String(wrapped)).toContain("WMS_SCAN_SHORTAGE");
    expect(wmsErrorCode(wrapped)).toBe("WMS_SCAN_SHORTAGE");
  });

  it("falls back to the shared normalizer for infrastructure failures", () => {
    const failure = toWmsFailure(new TypeError("Failed to fetch"));
    expect(failure.kind).toBe("system");
    expect(failure.retryable).toBe(true);
  });

  it("uses the caller's fallback copy when nothing matches", () => {
    expect(toWmsFailure({}, "Dispatch failed").message).toBe("Dispatch failed");
  });
});
