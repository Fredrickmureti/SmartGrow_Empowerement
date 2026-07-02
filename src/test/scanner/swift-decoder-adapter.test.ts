/**
 * @vitest-environment jsdom
 *
 * swiftDecoderAdapter — verifies the iOS Honeywell SwiftDecoder bridge
 * is a no-op without the sentinel, forwards `swiftdecoder` CustomEvents
 * to `nativeScanBus` when started, and cleanly detaches on stop().
 */

import { describe, it, expect, beforeEach } from "vitest";
import { swiftDecoderAdapter } from "@/services/scanner/native/swiftDecoderAdapter";
import { nativeScanBus, type NativeScan } from "@/services/scanner/native/nativeScanBus";

describe("swiftDecoderAdapter", () => {
  beforeEach(() => {
    nativeScanBus._reset();
    swiftDecoderAdapter._reset();
    delete (window as any).__swiftDecoderBridge__;
  });

  it("does not emit when no event is fired and no bridge is present", () => {
    const seen: NativeScan[] = [];
    nativeScanBus.on((s) => seen.push(s));
    swiftDecoderAdapter.start();
    expect(seen).toEqual([]);
    swiftDecoderAdapter.stop();
  });

  it("forwards a swiftdecoder CustomEvent to nativeScanBus with source=honeywell-ios", () => {
    const seen: NativeScan[] = [];
    nativeScanBus.on((s) => seen.push(s));
    swiftDecoderAdapter.start();

    window.dispatchEvent(new CustomEvent("swiftdecoder", {
      detail: { data: "5901234123457", codeId: "EAN-13", aimId: "]E0" },
    }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      code: "5901234123457",
      symbology: "EAN-13",
      aim: "]E0",
      source: "honeywell-ios",
    });
    swiftDecoderAdapter.stop();
  });

  it("stop() detaches the listener so later events are ignored", () => {
    const seen: NativeScan[] = [];
    nativeScanBus.on((s) => seen.push(s));
    swiftDecoderAdapter.start();
    swiftDecoderAdapter.stop();
    window.dispatchEvent(new CustomEvent("swiftdecoder", { detail: { data: "X" } }));
    expect(seen).toEqual([]);
  });
});
