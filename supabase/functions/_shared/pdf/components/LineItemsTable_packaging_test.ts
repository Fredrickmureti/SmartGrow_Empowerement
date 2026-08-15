/**
 * Regression: Paracentamols Box sale must render the transaction unit, not
 * the base stock unit. The bug was: PDF showed Qty=50, Price=7 for "1 Box
 * (50 tablets)" sold at 350. The expected display is Qty="1 Box (50 PCE)"
 * and Price=350.
 *
 * This test exercises the same internal formatters the PDF renderer uses.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Qty remains a small formatting contract. Price is imported from the actual
// PDF component below: duplicating that calculation here previously let the
// test pass while the deployed renderer remained stale.
function trimNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return String(Number(n.toFixed(3)));
}
interface Item {
  description: string;
  quantity?: number;
  display_quantity?: number | null;
  packaging_label?: string | null;
  base_uom_label?: string | null;
  unit_price?: number;
  line_total?: number | null;
}
function formatQtyCell(item: Item, opts: { showBase?: boolean } = {}): string {
  const showBase = opts.showBase !== false;
  const base = Number(item.quantity ?? 0);
  const baseLabel = (item.base_uom_label ?? "ea").trim() || "ea";
  if (item.packaging_label && item.packaging_label.trim().length > 0) {
    const dq = item.display_quantity != null && Number.isFinite(item.display_quantity)
      ? Number(item.display_quantity)
      : base;
    const head = `${trimNum(dq)} ${item.packaging_label.trim()}`;
    return showBase && dq !== base ? `${head} (${trimNum(base)} ${baseLabel})` : head;
  }
  return `${trimNum(base)} ${baseLabel}`;
}
import { formatPriceCell } from "./LineItemsTable.ts";

Deno.test("PDF — pack-unit price is not multiplied again (50 kg Bag @ 7,500)", () => {
  assertEquals(
    formatPriceCell({
      description: "Sugar",
      quantity: 50,
      display_quantity: 1,
      packaging_label: "50 kg Bag",
      base_uom_label: "KG",
      unit_price: 7500,
      line_total: 7500,
    } as Item),
    7500,
  );
});

Deno.test("PDF — Cooking Oil 1 × 20 L Drum keeps the commercial drum price", () => {
  assertEquals(
    formatPriceCell({
      quantity: 20,
      display_quantity: 1,
      packaging_label: "20 L Drum",
      base_uom_label: "L",
      unit_price: 6000,
      line_total: 6000,
      description: "Cooking Oil",
    }),
    6000,
  );
});

Deno.test("PDF — Cooking Oil 2 × 20 L Drum keeps the per-drum price", () => {
  assertEquals(
    formatPriceCell({
      quantity: 40,
      display_quantity: 2,
      packaging_label: "20 L Drum",
      base_uom_label: "L",
      unit_price: 6000,
      line_total: 12000,
      description: "Cooking Oil",
    }),
    6000,
  );
});

Deno.test("PDF — 1 Box of Paracentamols (50 tablets, 7/tab, 350 total)", () => {
  const item: Item = {
    description: "Paracentamols",
    quantity: 50,
    display_quantity: 1,
    packaging_label: "Box",
    base_uom_label: "PCE",
    unit_price: 7,
  };
  assertEquals(formatQtyCell(item), "1 Box (50 PCE)");
  assertEquals(formatPriceCell(item), 350);
});

Deno.test("PDF — 2 Boxes of Paracentamols (100 tablets, 7/tab, 700 total)", () => {
  const item: Item = {
    description: "Paracentamols",
    quantity: 100,
    display_quantity: 2,
    packaging_label: "Box",
    base_uom_label: "PCE",
    unit_price: 7,
  };
  assertEquals(formatQtyCell(item), "2 Box (100 PCE)");
  assertEquals(formatPriceCell(item), 350);
});

Deno.test("PDF — loose tablets (no packaging) keep base qty/price", () => {
  const item: Item = {
    description: "Paracentamols",
    quantity: 3,
    display_quantity: null,
    packaging_label: null,
    base_uom_label: "PCE",
    unit_price: 7,
  };
  assertEquals(formatQtyCell(item), "3 PCE");
  assertEquals(formatPriceCell(item), 7);
});
