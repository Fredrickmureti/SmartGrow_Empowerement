/**
 * scanBus cross-source dedupe — ensures a phone-paired camera scan and a
 * keyboard-wedge scan of the same barcode within 250ms only deliver
 * one ScanEvent to the cart.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { scanBus, type ScanEvent } from "@/services/pos/scanBus";

function ev(code: string, source: ScanEvent["source"], at: number): ScanEvent {
  return { raw: code, code, quantity: 1, at, source };
}

describe("scanBus cross-source dedupe", () => {
  beforeEach(() => scanBus._clear());

  it("collapses keyboard + camera scans of the same code within 250ms", () => {
    const received: ScanEvent[] = [];
    scanBus.on((e) => received.push(e));
    const t = Date.now();
    scanBus.emit(ev("123456", "keyboard", t));
    scanBus.emit(ev("123456", "camera", t + 100));
    expect(received).toHaveLength(1);
    expect(received[0].source).toBe("keyboard");
  });

  it("allows the second scan after the dedupe window elapses", () => {
    const received: ScanEvent[] = [];
    scanBus.on((e) => received.push(e));
    const t = Date.now();
    scanBus.emit(ev("123456", "camera", t));
    scanBus.emit(ev("123456", "camera", t + 300));
    expect(received).toHaveLength(2);
  });

  it("does not dedupe different codes", () => {
    const received: ScanEvent[] = [];
    scanBus.on((e) => received.push(e));
    const t = Date.now();
    scanBus.emit(ev("AAA", "camera", t));
    scanBus.emit(ev("BBB", "camera", t + 10));
    expect(received).toHaveLength(2);
  });
});