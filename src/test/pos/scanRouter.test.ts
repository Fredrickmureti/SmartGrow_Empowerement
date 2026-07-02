/**
 * scanRouter — stack precedence + consumed-event suppression.
 *
 * Guards the double-dispatch fix: when a focused target consumes a scan,
 * legacy `scanBus.on` consumers (POSTerminal cart, ReturnDialog) must
 * detect it via `scanRouter.wasConsumed(event)` and skip.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { scanBus, type ScanEvent } from "@/services/pos/scanBus";
import { scanRouter } from "@/services/pos/scanRouter";

function mkEvent(code: string): ScanEvent {
  return { raw: code, code, quantity: 1, at: Date.now(), source: "manual" };
}

describe("scanRouter", () => {
  beforeEach(() => {
    scanBus._clear();
    scanRouter._clear();
  });

  it("dispatches to the topmost registered target", () => {
    const calls: string[] = [];
    scanRouter.register({ id: "a", priority: 0, onScan: () => calls.push("a") });
    scanRouter.register({ id: "b", priority: 0, onScan: () => calls.push("b") });
    scanBus.emit(mkEvent("123456"));
    expect(calls).toEqual(["b"]);
  });

  it("higher priority wins regardless of order", () => {
    const calls: string[] = [];
    scanRouter.register({ id: "low", priority: 0, onScan: () => calls.push("low") });
    scanRouter.register({ id: "high", priority: 10, onScan: () => calls.push("high") });
    scanRouter.register({ id: "low2", priority: 0, onScan: () => calls.push("low2") });
    scanBus.emit(mkEvent("999999"));
    expect(calls).toEqual(["high"]);
  });

  it("marks consumed events so legacy bus consumers can skip", () => {
    const busHits: string[] = [];
    let consumedSeen = false;
    scanBus.on((event) => {
      if (scanRouter.wasConsumed(event)) {
        consumedSeen = true;
        return;
      }
      busHits.push(event.code);
    });
    scanRouter.register({ id: "field", priority: 10, onScan: () => {} });
    scanBus.emit(mkEvent("888888"));
    expect(consumedSeen).toBe(true);
    expect(busHits).toEqual([]);
  });

  it("does not mark events as consumed when no target is registered", () => {
    const busHits: string[] = [];
    scanBus.on((event) => {
      if (scanRouter.wasConsumed(event)) return;
      busHits.push(event.code);
    });
    scanBus.emit(mkEvent("777777"));
    expect(busHits).toEqual(["777777"]);
  });

  it("unregister removes the target from the stack", () => {
    const calls: string[] = [];
    const off = scanRouter.register({ id: "x", priority: 10, onScan: () => calls.push("x") });
    off();
    scanBus.emit(mkEvent("555555"));
    expect(calls).toEqual([]);
  });

  it("default targets are subject to the scanBus 250 ms cross-source dedupe", () => {
    const calls: string[] = [];
    scanRouter.register({ id: "default", priority: 10, onScan: (e) => calls.push(e.code) });
    const now = Date.now();
    scanBus.emit({ raw: "BAR1", code: "BAR1", quantity: 1, at: now, source: "keyboard" });
    scanBus.emit({ raw: "BAR1", code: "BAR1", quantity: 1, at: now + 50, source: "camera" });
    expect(calls).toEqual(["BAR1"]);
  });

  it("allowRepeats target bypasses the dedupe so repeat scans count", () => {
    const calls: string[] = [];
    scanRouter.register({
      id: "count",
      priority: 10,
      allowRepeats: true,
      onScan: (e) => calls.push(e.code),
    });
    const now = Date.now();
    scanBus.emit({ raw: "BAR2", code: "BAR2", quantity: 1, at: now, source: "keyboard" });
    scanBus.emit({ raw: "BAR2", code: "BAR2", quantity: 1, at: now + 50, source: "keyboard" });
    scanBus.emit({ raw: "BAR2", code: "BAR2", quantity: 1, at: now + 100, source: "camera" });
    expect(calls).toEqual(["BAR2", "BAR2", "BAR2"]);
  });
});
