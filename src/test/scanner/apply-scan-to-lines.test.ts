import { describe, it, expect } from "vitest";
import { applyScanToLines } from "@/services/scanner/applyScanToLines";

interface Line { product_id: string; quantity: number }

describe("applyScanToLines", () => {
  const buildLine = (q: number): Line => ({ product_id: "p1", quantity: q });
  const incrementLine = (l: Line, q: number) => ({ quantity: l.quantity + q });

  it("appends a new line when no match", () => {
    const r = applyScanToLines<Line>({
      lines: [{ product_id: "other", quantity: 1 }],
      matchLine: (l) => l.product_id === "p1",
      buildLine,
      incrementLine,
    });
    expect(r.mode).toBe("added");
    expect(r.affectedIndex).toBe(1);
    expect(r.next).toHaveLength(2);
    expect(r.next[1]).toEqual({ product_id: "p1", quantity: 1 });
  });

  it("increments the matched line and leaves all others untouched", () => {
    const lines: Line[] = [
      { product_id: "p0", quantity: 2 },
      { product_id: "p1", quantity: 3 },
    ];
    const r = applyScanToLines<Line>({
      lines,
      matchLine: (l) => l.product_id === "p1",
      buildLine,
      incrementLine,
      scanQuantity: 2,
    });
    expect(r.mode).toBe("incremented");
    expect(r.affectedIndex).toBe(1);
    expect(r.next[1].quantity).toBe(5);
    expect(r.next).not.toBe(lines); // new array
    expect(lines[1].quantity).toBe(3); // input unmodified
  });

  it("replaces a trailing empty placeholder when asked", () => {
    const lines: Line[] = [{ product_id: "", quantity: 1 }];
    const r = applyScanToLines<Line>({
      lines,
      matchLine: (l) => l.product_id === "p1",
      buildLine,
      incrementLine,
      replaceTrailingEmpty: true,
      isEmptyLine: (l) => !l.product_id,
    });
    expect(r.mode).toBe("added");
    expect(r.next).toHaveLength(1);
    expect(r.next[0]).toEqual({ product_id: "p1", quantity: 1 });
  });

  it("does NOT replace trailing empty when matched line exists", () => {
    const lines: Line[] = [
      { product_id: "p1", quantity: 1 },
      { product_id: "", quantity: 1 },
    ];
    const r = applyScanToLines<Line>({
      lines,
      matchLine: (l) => l.product_id === "p1",
      buildLine,
      incrementLine,
      replaceTrailingEmpty: true,
      isEmptyLine: (l) => !l.product_id,
    });
    expect(r.mode).toBe("incremented");
    expect(r.next).toHaveLength(2);
    expect(r.next[0].quantity).toBe(2);
  });
});