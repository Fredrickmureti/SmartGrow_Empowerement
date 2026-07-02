/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dataWedgeAdapter } from "@/services/scanner/native/dataWedgeAdapter";
import { nativeScanBus, type NativeScan } from "@/services/scanner/native/nativeScanBus";

describe("dataWedgeAdapter", () => {
  let received: NativeScan[] = [];
  let off: () => void;
  beforeEach(() => {
    received = [];
    nativeScanBus._reset();
    dataWedgeAdapter._reset();
    off = nativeScanBus.on((s) => received.push(s));
    dataWedgeAdapter.start();
  });
  afterEach(() => {
    off?.();
    dataWedgeAdapter.stop();
    vi.useRealTimers();
  });

  it("normalises a CustomEvent payload into a NativeScan", () => {
    window.dispatchEvent(
      new CustomEvent("datawedge", { detail: { data: "5901234123457", labelType: "LABEL-TYPE-EAN13" } }),
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      code: "5901234123457",
      symbology: "LABEL-TYPE-EAN13",
      source: "zebra",
    });
  });

  it("accepts a JSON string detail (intent shim variant)", () => {
    window.dispatchEvent(
      new CustomEvent("datawedge", { detail: JSON.stringify({ data: "ABC123" }) }),
    );
    expect(received).toHaveLength(1);
    expect(received[0].code).toBe("ABC123");
  });

  it("dedupes the same code within 200ms (bridge + intent double-fire)", () => {
    window.dispatchEvent(new CustomEvent("datawedge", { detail: { data: "DUP" } }));
    window.dispatchEvent(new CustomEvent("datawedge", { detail: { data: "DUP" } }));
    expect(received).toHaveLength(1);
  });

  it("ignores empty / non-string data without throwing", () => {
    window.dispatchEvent(new CustomEvent("datawedge", { detail: { data: "" } }));
    window.dispatchEvent(new CustomEvent("datawedge", { detail: { data: 42 } }));
    window.dispatchEvent(new CustomEvent("datawedge", { detail: null }));
    expect(received).toHaveLength(0);
  });

  it("stop() detaches the listener", () => {
    dataWedgeAdapter.stop();
    window.dispatchEvent(new CustomEvent("datawedge", { detail: { data: "X" } }));
    expect(received).toHaveLength(0);
  });
});
