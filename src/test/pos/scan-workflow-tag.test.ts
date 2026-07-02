/**
 * Workflow tag on scanRouter targets — declarative, not enforced at runtime.
 *
 * This test pins the contract surfaced by Step D of the
 * 2026-05-19 scan-semantics audit: any caller may attach a `workflow`
 * tag to a registered target, and the router exposes it via `_inspect`
 * so tests / future lints can detect misconfigured stacks (e.g. a
 * `quantity` target mounted above an `identity` target).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { scanBus } from "@/services/pos/scanBus";
import { scanRouter } from "@/services/pos/scanRouter";

describe("scanRouter workflow tag", () => {
  beforeEach(() => {
    scanBus._clear();
    scanRouter._clear();
  });

  it("preserves workflow tag on registered targets", () => {
    scanRouter.register({ id: "field", priority: 10, workflow: "identity", onScan: () => {} });
    scanRouter.register({ id: "cart", priority: 0, workflow: "quantity", onScan: () => {} });
    const { stack } = scanRouter._inspect();
    expect(stack.map((s) => [s.id, s.workflow])).toEqual([
      ["field", "identity"],
      ["cart", "quantity"],
    ]);
  });

  it("does not change runtime dispatch — priority still wins", () => {
    const calls: string[] = [];
    scanRouter.register({
      id: "cart",
      priority: 0,
      workflow: "quantity",
      onScan: () => calls.push("cart"),
    });
    scanRouter.register({
      id: "field",
      priority: 10,
      workflow: "identity",
      onScan: () => calls.push("field"),
    });
    scanBus.emit({ raw: "X", code: "X", quantity: 1, at: Date.now(), source: "manual" });
    expect(calls).toEqual(["field"]);
  });
});
