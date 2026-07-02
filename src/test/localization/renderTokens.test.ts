/**
 * renderTokens unit tests
 * The runtime resolver and the editor preview MUST agree on the
 * `‹unresolved: ...›` sentinel — these tests pin that contract.
 */
import { describe, it, expect } from "vitest";
import {
  renderString,
  renderTokens,
  lookup,
} from "../../../supabase/functions/_shared/renderTokens.ts";

describe("renderTokens — lookup", () => {
  it("resolves a dotted path", () => {
    expect(lookup({ employee: { full_name: "Alice" } }, "employee.full_name")).toBe("Alice");
  });
  it("returns undefined on miss", () => {
    expect(lookup({ a: { b: 1 } }, "a.c")).toBeUndefined();
  });
});

describe("renderTokens — renderString", () => {
  it("substitutes a single token", () => {
    const misses: string[] = [];
    expect(renderString("Hello {{name}}", { name: "Alice" }, misses)).toBe("Hello Alice");
    expect(misses).toEqual([]);
  });

  it("emits the sentinel for missing tokens and records the miss", () => {
    const misses: string[] = [];
    expect(renderString("Hi {{a.b}}", { a: {} }, misses)).toBe("Hi ‹unresolved: a.b›");
    expect(misses).toEqual(["a.b"]);
  });

  it("stringifies non-string values", () => {
    const misses: string[] = [];
    expect(renderString("{{n}}-{{o}}", { n: 42, o: { x: 1 } }, misses)).toBe('42-{"x":1}');
    expect(misses).toEqual([]);
  });
});

describe("renderTokens — recursive body", () => {
  const body = {
    blocks: [
      { id: "header", content: "Payslip for {{employee.full_name}}" },
      { id: "totals", content: "Net: {{run.net_pay}}" },
      { id: "missing", content: "Tax: {{employee.tax_id}}" },
    ],
    meta: { period: "{{run.period_end}}" },
  };

  it("walks every string and collects misses", () => {
    const ctx = {
      employee: { full_name: "Alice" },
      run: { net_pay: 1234, period_end: "2026-04-30" },
    };
    const { rendered, misses } = renderTokens(body, ctx);
    expect(rendered.blocks[0].content).toBe("Payslip for Alice");
    expect(rendered.blocks[1].content).toBe("Net: 1234");
    expect(rendered.blocks[2].content).toBe("Tax: ‹unresolved: employee.tax_id›");
    expect(rendered.meta.period).toBe("2026-04-30");
    expect(misses).toEqual(["employee.tax_id"]);
  });

  it("does not mutate the input body", () => {
    const before = JSON.stringify(body);
    renderTokens(body, { employee: { full_name: "X" }, run: {} });
    expect(JSON.stringify(body)).toBe(before);
  });
});
