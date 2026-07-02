/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { honeywellAdapter } from "@/services/scanner/native/honeywellAdapter";
import { nativeScanBus, type NativeScan } from "@/services/scanner/native/nativeScanBus";

describe("honeywellAdapter", () => {
  let received: NativeScan[] = [];
  let off: () => void;
  beforeEach(() => {
    received = [];
    nativeScanBus._reset();
    honeywellAdapter._reset();
    off = nativeScanBus.on((s) => received.push(s));
    honeywellAdapter.start();
  });
  afterEach(() => {
    off?.();
    honeywellAdapter.stop();
  });

  it("normalises a honeywellscan CustomEvent", () => {
    window.dispatchEvent(
      new CustomEvent("honeywellscan", { detail: { data: "0123456789012", codeId: "j", aimId: "]E0" } }),
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      code: "0123456789012",
      symbology: "j",
      aim: "]E0",
      source: "honeywell",
    });
  });

  it("dedupes the same code within 200ms", () => {
    window.dispatchEvent(new CustomEvent("honeywellscan", { detail: { data: "DUP" } }));
    window.dispatchEvent(new CustomEvent("honeywellscan", { detail: { data: "DUP" } }));
    expect(received).toHaveLength(1);
  });

  it("stop() detaches", () => {
    honeywellAdapter.stop();
    window.dispatchEvent(new CustomEvent("honeywellscan", { detail: { data: "X" } }));
    expect(received).toHaveLength(0);
  });
});
