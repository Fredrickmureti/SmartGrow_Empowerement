/**
 * @vitest-environment jsdom
 *
 * useNativeScanner — verifies the hook only attaches an adapter when a
 * vendor is detected AND the operator toggle is on; that fired DataWedge
 * `CustomEvent`s reach the caller's `onScan` through `nativeScanBus`;
 * and that visibility changes pause/resume the adapter without leaking
 * listeners on unmount.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNativeScanner } from "@/hooks/scanner/useNativeScanner";
import { nativeScanBus } from "@/services/scanner/native/nativeScanBus";
import { dataWedgeAdapter } from "@/services/scanner/native/dataWedgeAdapter";
import { swiftDecoderAdapter } from "@/services/scanner/native/swiftDecoderAdapter";
import * as detector from "@/services/scanner/native/detectNativeScanner";

function fireDataWedge(detail: unknown) {
  window.dispatchEvent(new CustomEvent("datawedge", { detail }));
}

describe("useNativeScanner", () => {
  beforeEach(() => {
    nativeScanBus._reset();
    dataWedgeAdapter._reset();
    swiftDecoderAdapter._reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a no-op and reports vendor:null when no native engine is detected", () => {
    vi.spyOn(detector, "detectNativeScanner").mockReturnValue({
      vendor: null, transport: "keystroke", confidence: 0, label: null,
    });
    const onScan = vi.fn();
    const { result } = renderHook(() => useNativeScanner({ enabled: true, onScan }));
    expect(result.current.capability.vendor).toBeNull();
    expect(result.current.active).toBe(false);
    fireDataWedge({ data: "0123" });
    expect(onScan).not.toHaveBeenCalled();
  });

  it("starts the Zebra adapter and forwards a normalized scan to onScan", () => {
    vi.spyOn(detector, "detectNativeScanner").mockReturnValue({
      vendor: "zebra", transport: "intent", confidence: 0.9, label: "Zebra DataWedge",
    });
    const onScan = vi.fn();
    const { result, unmount } = renderHook(() => useNativeScanner({ enabled: true, onScan }));
    expect(result.current.active).toBe(true);

    fireDataWedge({ data: "5901234123457", labelType: "EAN-13" });
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0][0]).toMatchObject({
      code: "5901234123457",
      symbology: "EAN-13",
      source: "zebra",
    });

    unmount();
    onScan.mockClear();
    fireDataWedge({ data: "OTHER" });
    expect(onScan).not.toHaveBeenCalled();
  });

  it("operator toggle off keeps the adapter detached even on a Zebra device", () => {
    vi.spyOn(detector, "detectNativeScanner").mockReturnValue({
      vendor: "zebra", transport: "intent", confidence: 0.9, label: "Zebra DataWedge",
    });
    const onScan = vi.fn();
    const { result } = renderHook(() => useNativeScanner({ enabled: false, onScan }));
    expect(result.current.active).toBe(false);
    fireDataWedge({ data: "X" });
    expect(onScan).not.toHaveBeenCalled();
  });

  it("pauses on visibilitychange→hidden and resumes on →visible", () => {
    vi.spyOn(detector, "detectNativeScanner").mockReturnValue({
      vendor: "zebra", transport: "intent", confidence: 0.9, label: "Zebra DataWedge",
    });
    const onScan = vi.fn();
    renderHook(() => useNativeScanner({ enabled: true, onScan }));

    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    fireDataWedge({ data: "WHILE_HIDDEN" });
    expect(onScan).not.toHaveBeenCalled();

    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    fireDataWedge({ data: "WHILE_VISIBLE" });
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0][0].code).toBe("WHILE_VISIBLE");
  });

  it("starts the SwiftDecoder adapter when vendor is honeywell-ios", () => {
    vi.spyOn(detector, "detectNativeScanner").mockReturnValue({
      vendor: "honeywell-ios", transport: "js-bridge", confidence: 1, label: "SwiftDecoder",
    });
    const onScan = vi.fn();
    const { result, unmount } = renderHook(() => useNativeScanner({ enabled: true, onScan }));
    expect(result.current.active).toBe(true);

    window.dispatchEvent(new CustomEvent("swiftdecoder", {
      detail: { data: "ABC123", codeId: "Code128" },
    }));
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0][0]).toMatchObject({
      code: "ABC123", symbology: "Code128", source: "honeywell-ios",
    });
    unmount();
  });
});
