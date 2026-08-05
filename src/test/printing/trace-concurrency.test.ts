/**
 * Phase 1R guardrail — the instrument itself must be concurrency-safe.
 *
 * The first tracer kept the active trace in a module-global. Two prints in
 * flight at once (a label while an invoice renders, N copies of a receipt)
 * clobbered one another's span lists, so the waterfall lied exactly when the
 * system was busiest. Spans are now keyed by correlation id; these tests
 * pin that behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn(async () => ({ error: null }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({ insert: (row: unknown) => insert(row) }) },
}));

import { withTrace, withSpan, addSpan, annotateTrace } from "@/services/observability/trace";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("trace concurrency", () => {
  beforeEach(() => {
    insert.mockClear();
  });

  it("keeps overlapping traces' span lists disjoint", async () => {
    const seen: Record<string, string[]> = {};

    await Promise.all([
      withTrace({ label: "invoice", correlationId: "corr-a" }, async (ctx) => {
        await withSpan("render.document", () => tick(10), undefined, ctx.correlationId);
        await tick(5);
        await withSpan("dispatch.copy", () => tick(5), undefined, ctx.correlationId);
        seen.a = ctx.spans.map((s) => s.name);
      }),
      withTrace({ label: "label", correlationId: "corr-b" }, async (ctx) => {
        await withSpan("label.render", () => tick(8), undefined, ctx.correlationId);
        seen.b = ctx.spans.map((s) => s.name);
      }),
    ]);

    expect(seen.a).toEqual(["render.document", "dispatch.copy"]);
    expect(seen.b).toEqual(["label.render"]);
  });

  it("routes annotations and externally measured spans by correlation id", async () => {
    await Promise.all([
      withTrace({ label: "a", correlationId: "corr-1" }, async (ctx) => {
        annotateTrace({ copies: 2 }, "corr-1");
        addSpan("agent.socket", 42, { transport: "relay" }, true, "corr-1");
        await tick(5);
        expect(ctx.attributes.copies).toBe(2);
        expect(ctx.spans.map((s) => s.name)).toEqual(["agent.socket"]);
      }),
      withTrace({ label: "b", correlationId: "corr-2" }, async (ctx) => {
        await tick(2);
        expect(ctx.attributes.copies).toBeUndefined();
        expect(ctx.spans).toHaveLength(0);
      }),
    ]);
  });

  it("joins a re-entered correlation id instead of forking a second waterfall", async () => {
    await withTrace({ label: "outer", correlationId: "corr-join" }, async (outer) => {
      await withTrace({ label: "inner", correlationId: "corr-join" }, async (inner) => {
        expect(inner).toBe(outer);
        await withSpan("inner.stage", () => tick(1), undefined, "corr-join");
      });
      expect(outer.spans.map((s) => s.name)).toEqual(["inner.stage"]);
    });

    // One flush for one cashier action.
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("flushes each finished trace exactly once, with its own spans", async () => {
    await Promise.all([
      withTrace({ label: "receipt", correlationId: "corr-x" }, async () => {
        await withSpan("x.stage", () => tick(3), undefined, "corr-x");
      }),
      withTrace({ label: "invoice", correlationId: "corr-y" }, async () => {
        await withSpan("y.stage", () => tick(3), undefined, "corr-y");
      }),
    ]);
    await tick(0);

    expect(insert).toHaveBeenCalledTimes(2);
    const rows = insert.mock.calls.map((c) => c[0] as { correlation_id: string; spans: { name: string }[] });
    const byId = Object.fromEntries(rows.map((r) => [r.correlation_id, r.spans.map((s) => s.name)]));
    expect(byId["corr-x"]).toEqual(["x.stage"]);
    expect(byId["corr-y"]).toEqual(["y.stage"]);
  });

  it("drops spans with no live trace rather than throwing", async () => {
    await expect(withSpan("orphan", () => "value", undefined, "no-such-trace")).resolves.toBe("value");
    expect(() => addSpan("orphan", 5, undefined, true, "no-such-trace")).not.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});
