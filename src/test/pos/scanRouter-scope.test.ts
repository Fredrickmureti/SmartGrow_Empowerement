/**
 * Scanner Scope policy — router-level filtering.
 *
 * Verifies that an `acceptsTopic`-decorated target rejects scans from
 * the wrong realtime topic, and that the router walks down the stack
 * to find an accepting target. Keyboard / manual scans (no topic) are
 * never filtered.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { scanBus, type ScanEvent } from "@/services/pos/scanBus";
import { scanRouter } from "@/services/pos/scanRouter";

function ev(opts: Partial<ScanEvent> & { code: string }): ScanEvent {
  return {
    raw: opts.code,
    code: opts.code,
    quantity: 1,
    at: Date.now(),
    source: opts.source ?? "camera",
    sourceTopic: opts.sourceTopic,
    scanId: opts.scanId,
  };
}

describe("scanRouter — Scanner Scope filtering", () => {
  beforeEach(() => {
    scanBus._clear();
    scanRouter._clear();
  });

  it("workspace field rejects POS-register scans in scoped mode", () => {
    const calls: string[] = [];
    scanRouter.register({
      id: "workspace-field",
      priority: 10,
      onScan: (e) => calls.push(e.code),
      acceptsTopic: (topic) => !topic || topic.startsWith("scan:session:"),
    });
    scanBus.emit(ev({ code: "ABC1", sourceTopic: "pos:scan:reg-1" }));
    expect(calls).toEqual([]);
  });

  it("workspace field accepts its own session topic + keyboard", () => {
    const calls: string[] = [];
    const workspaceTopic = "scan:session:abc-123";
    scanRouter.register({
      id: "workspace-field",
      priority: 10,
      onScan: (e) => calls.push(e.code),
      acceptsTopic: (topic) =>
        !topic || (topic.startsWith("scan:session:") && topic === workspaceTopic),
    });
    scanBus.emit(ev({ code: "OK1", sourceTopic: workspaceTopic }));
    scanBus.emit(ev({ code: "KEY1", source: "keyboard" }));
    scanBus.emit(ev({ code: "OTHER", sourceTopic: "scan:session:different-uuid" }));
    expect(calls).toEqual(["OK1", "KEY1"]);
  });

  it("router walks down stack to find an accepting target", () => {
    const hits: string[] = [];
    scanRouter.register({
      id: "ambient-fallback",
      priority: 0,
      onScan: (e) => hits.push(`fallback:${e.code}`),
    });
    scanRouter.register({
      id: "picky-top",
      priority: 10,
      onScan: (e) => hits.push(`top:${e.code}`),
      acceptsTopic: (topic) => !topic || topic.startsWith("scan:session:"),
    });
    scanBus.emit(ev({ code: "POS1", sourceTopic: "pos:scan:reg-1" }));
    expect(hits).toEqual(["fallback:POS1"]);
  });

  it("when no target accepts, event is dropped and not marked consumed", () => {
    scanRouter.register({
      id: "picky",
      priority: 10,
      onScan: () => {},
      acceptsTopic: () => false,
    });
    const e = ev({ code: "DROP", sourceTopic: "pos:scan:reg-1" });
    scanBus.emit(e);
    expect(scanRouter.wasConsumed(e)).toBe(false);
  });

  it("Ambient default: target with no acceptsTopic gets everything", () => {
    const calls: string[] = [];
    scanRouter.register({
      id: "ambient",
      priority: 10,
      onScan: (e) => calls.push(e.code),
    });
    scanBus.emit(ev({ code: "A1", sourceTopic: "pos:scan:reg-1" }));
    scanBus.emit(ev({ code: "A2", sourceTopic: "scan:session:x" }));
    scanBus.emit(ev({ code: "A3", source: "keyboard" }));
    expect(calls).toEqual(["A1", "A2", "A3"]);
  });
});