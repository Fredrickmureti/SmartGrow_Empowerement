import { describe, it, expect } from "vitest";
import { solveColumns, renderRow, renderHeader, wordWrap, padLR } from "@/lib/receipt/engine/ColumnLayout";

describe("ColumnLayout", () => {
  it("distributes fr widths after fixed deductions", () => {
    const cols = solveColumns(
      [
        { key: "a", header: "A", width: 5, align: "left" },
        { key: "b", header: "B", width: { fr: 1, min: 4 }, align: "left" },
        { key: "c", header: "C", width: 4, align: "right" },
      ],
      48,
      1,
    );
    // 48 - (5+4) - 2 gaps = 37 left for fr column
    expect(cols.map((c) => c.resolvedWidth)).toEqual([5, 37, 4]);
  });

  it("renders a row with right-aligned numeric column", () => {
    const cols = solveColumns(
      [
        { key: "name", header: "Item", width: { fr: 1, min: 8 }, align: "left" },
        { key: "qty", header: "Qty", width: 5, align: "right" },
        { key: "total", header: "Total", width: 10, align: "right" },
      ],
      48,
      1,
    );
    const header = renderHeader(cols, 1);
    expect(header.endsWith("Total".padStart(10))).toBe(true);
    const row = renderRow({ name: "Widget", qty: "2", total: "1,000.00" }, cols, 1);
    expect(row).toHaveLength(1);
    expect(row[0].endsWith("1,000.00".padStart(10))).toBe(true);
    expect(row[0].length).toBe(header.length);
  });

  it("wraps long names into continuation rows preserving column alignment", () => {
    const cols = solveColumns(
      [
        { key: "name", header: "Item", width: { fr: 1, min: 8, max: 20 }, align: "left", wrap: true },
        { key: "total", header: "Total", width: 10, align: "right" },
      ],
      32,
      1,
    );
    const rows = renderRow(
      { name: "Premium Coffee Blend Deluxe Edition", total: "9.99" },
      cols,
      1,
    );
    expect(rows.length).toBeGreaterThan(1);
    // Continuation rows have empty total column padded to width.
    expect(rows[1].endsWith("          ")).toBe(true);
    for (const r of rows) expect(r.length).toBe(rows[0].length);
  });

  it("padLR pads two strings to a fixed width", () => {
    const s = padLR("Subtotal", "1,234.50", 32);
    expect(s.length).toBe(32);
    expect(s.startsWith("Subtotal")).toBe(true);
    expect(s.endsWith("1,234.50")).toBe(true);
  });

  it("wordWrap splits long text but keeps short words intact", () => {
    expect(wordWrap("hello world", 12)).toEqual(["hello world"]);
    expect(wordWrap("hello world", 5)).toEqual(["hello", "world"]);
    expect(wordWrap("supercalifragilistic", 6)).toEqual(["superc", "alifra", "gilist", "ic"]);
  });
});
