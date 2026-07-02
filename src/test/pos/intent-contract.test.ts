/**
 * Intent contract — Plan Pillar A / P1+.
 *
 * The router promotes the declarative `workflow` tag to a runtime
 * contract: two non-identity intents at the SAME priority cannot
 * coexist. This locks in the architectural guard that prevents a
 * future module from silently re-introducing POS-style qty++ semantics
 * (`pos_sell`) into a Sales / doc-authoring workspace (`doc_author`).
 *
 * Also pins the burst-correctness guarantee: a workspace target must
 * be able to handle 5 distinct rapid scans without dropping any of
 * them on the floor (the previous single-boolean `inFlightRef` did).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { scanBus, type ScanEvent } from "@/services/pos/scanBus";
import { scanRouter } from "@/services/pos/scanRouter";

function mkEvent(code: string, at = Date.now()): ScanEvent {
  return { raw: code, code, quantity: 1, at, source: "manual" };
}

describe("scanRouter intent contract", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scanBus._clear();
    scanRouter._clear();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("rejects a doc_author target mounted alongside pos_sell at same priority", () => {
    const calls: string[] = [];
    const offSell = scanRouter.register({
      id: "pos",
      priority: 5,
      intent: "pos_sell",
      onScan: () => calls.push("pos"),
    });
    const offDoc = scanRouter.register({
      id: "sales",
      priority: 5,
      intent: "doc_author",
      onScan: () => calls.push("sales"),
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/intent conflict/);

    // pos_sell is the only one actually in the stack, so it receives the scan.
    scanBus.emit(mkEvent("BAR1"));
    expect(calls).toEqual(["pos"]);

    // The rejected registration returns a no-op cleanup safely.
    expect(() => offDoc()).not.toThrow();
    offSell();
  });

  it("allows identity to coexist with any other intent at same priority", () => {
    const calls: string[] = [];
    scanRouter.register({
      id: "field",
      priority: 10,
      intent: "identity",
      onScan: () => calls.push("field"),
    });
    scanRouter.register({
      id: "sales",
      priority: 10,
      intent: "doc_author",
      onScan: () => calls.push("sales"),
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("allows the same intent on different priorities to coexist", () => {
    scanRouter.register({ id: "a", priority: 0, intent: "pos_sell", onScan: () => {} });
    scanRouter.register({ id: "b", priority: 10, intent: "doc_author", onScan: () => {} });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not drop a burst of 5 distinct scans into a single workspace target", async () => {
    const inFlight = new Set<string>();
    const seen: string[] = [];
    const resolve = async (code: string) => {
      if (inFlight.has(code)) return; // per-code dedupe, not global
      inFlight.add(code);
      await Promise.resolve();
      seen.push(code);
      inFlight.delete(code);
    };

    scanRouter.register({
      id: "workspace",
      priority: 5,
      intent: "doc_author",
      onScan: (e) => { void resolve(e.code); },
    });

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      scanBus.emit(mkEvent(`BAR${i}`, now + i * 10));
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.sort()).toEqual(["BAR0", "BAR1", "BAR2", "BAR3", "BAR4"]);
  });
});
