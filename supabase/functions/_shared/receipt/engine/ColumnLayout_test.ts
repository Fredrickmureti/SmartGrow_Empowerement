/**
 * Deno port of src/test/receipt/column-layout.test.ts. Keeps the column
 * solver / row renderer covered on the edge-function side so a Deno-only
 * regression cannot slip past CI.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  solveColumns,
  renderRow,
  renderHeader,
  wordWrap,
  padLR,
} from "./ColumnLayout.ts";

Deno.test("ColumnLayout: distributes fr widths after fixed deductions", () => {
  const cols = solveColumns(
    [
      { key: "a", header: "A", width: 5, align: "left" },
      { key: "b", header: "B", width: { fr: 1, min: 4 }, align: "left" },
      { key: "c", header: "C", width: 4, align: "right" },
    ],
    48,
    1,
  );
  assertEquals(cols.map((c) => c.resolvedWidth), [5, 37, 4]);
});

Deno.test("ColumnLayout: renders a row with right-aligned numeric column", () => {
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
  assert(header.endsWith("Total".padStart(10)));
  const row = renderRow({ name: "Widget", qty: "2", total: "1,000.00" }, cols, 1);
  assertEquals(row.length, 1);
  assert(row[0].endsWith("1,000.00".padStart(10)));
  assertEquals(row[0].length, header.length);
});

Deno.test("ColumnLayout: wraps long names into continuation rows preserving alignment", () => {
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
  assert(rows.length > 1);
  assert(rows[1].endsWith(" ".repeat(10)));
  for (const r of rows) assertEquals(r.length, rows[0].length);
});

Deno.test("ColumnLayout: padLR pads two strings to a fixed width", () => {
  const s = padLR("Subtotal", "1,234.50", 32);
  assertEquals(s.length, 32);
  assert(s.startsWith("Subtotal"));
  assert(s.endsWith("1,234.50"));
});

Deno.test("ColumnLayout: wordWrap splits long text but keeps short words intact", () => {
  assertEquals(wordWrap("hello world", 12), ["hello world"]);
  assertEquals(wordWrap("hello world", 5), ["hello", "world"]);
  assertEquals(wordWrap("supercalifragilistic", 6), ["superc", "alifra", "gilist", "ic"]);
});
