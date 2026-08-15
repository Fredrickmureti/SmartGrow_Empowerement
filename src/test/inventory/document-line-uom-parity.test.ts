import { describe, it, expect } from "vitest";
import { normalizeLineItemUom } from "@/services/documents/snapshots/lineItemUom";
import { formatLineQtyString } from "@/lib/inventory/uom";
import { formatTransactionQty } from "@/lib/inventory/formatQty";

/**
 * Phase 4 + 6 — one quantity story across the app, the PDF and the receipt.
 *
 * The PDF table (`_shared/pdf/components/LineItemsTable.ts::formatQtyCell`)
 * and the thermal receipt (`_shared/receipt/items.ts`) branch on
 * `display_quantity` / `packaging_label` / `base_uom_label`. The client-side
 * snapshot normalizer used to emit none of them, so an invoice line for
 * "1 Box of 100 tablets" printed "100 ea".
 */

/** Mirrors the Deno-side `formatQtyCell` exactly (golden reference). */
function pdfQtyCell(item: {
  quantity: number;
  display_quantity: number | null;
  packaging_label: string | null;
  base_uom_label: string | null;
}): string {
  const trim = (n: number) => (Number.isFinite(n) ? String(Number(n.toFixed(3))) : "0");
  const base = Number(item.quantity ?? 0);
  const baseLabel = (item.base_uom_label ?? "ea").trim() || "ea";
  if (item.packaging_label && item.packaging_label.trim().length > 0) {
    const dq =
      item.display_quantity != null && Number.isFinite(item.display_quantity)
        ? Number(item.display_quantity)
        : base;
    const head = `${trim(dq)} ${item.packaging_label.trim()}`;
    return dq !== base ? `${head} (${trim(base)} ${baseLabel})` : head;
  }
  return `${trim(base)} ${baseLabel}`;
}

const GOLDEN = [
  {
    name: "1 Box of 100 tablets",
    row: {
      quantity: 100,
      display_quantity: 1,
      uom_snapshot_pack_name: "Box",
      uom_snapshot_factor: 100,
      uom_snapshot_base_code: "PCE",
    },
    expected: "1 Box (100 PCE)",
  },
  {
    name: "2 Boxes",
    row: {
      quantity: 200,
      display_quantity: 2,
      uom_snapshot_pack_name: "Box",
      uom_snapshot_factor: 100,
      uom_snapshot_base_code: "PCE",
    },
    expected: "2 Box (200 PCE)",
  },
  {
    name: "fractional bulk sale, no packaging",
    row: {
      quantity: 17.005,
      display_quantity: null,
      product: { base_uom: { code: "KG", name: "Kilogram" } },
    },
    expected: "17.005 KG",
  },
  {
    name: "loose pieces",
    row: {
      quantity: 3,
      display_quantity: null,
      product: { base_uom: { code: "ea", name: "Each" } },
    },
    expected: "3 ea",
  },
] as const;

describe("document line quantity — normalizer feeds the renderers", () => {
  for (const c of GOLDEN) {
    it(`${c.name}: PDF cell reads "${c.expected}"`, () => {
      const n = normalizeLineItemUom(c.row);
      expect(
        pdfQtyCell({
          quantity: Number(c.row.quantity),
          display_quantity: n.display_quantity,
          packaging_label: n.packaging_label,
          base_uom_label: n.base_uom_label,
        }),
      ).toBe(c.expected);
    });

    it(`${c.name}: in-app formatter agrees with the PDF`, () => {
      expect(formatLineQtyString(c.row as never)).toBe(c.expected);
    });

    it(`${c.name}: legacy formatTransactionQty agrees too`, () => {
      const n = normalizeLineItemUom(c.row);
      expect(
        formatTransactionQty(
          n.display_quantity ?? Number(c.row.quantity),
          n.packaging_label,
          Number(c.row.quantity),
          n.base_uom_label ?? "ea",
        ),
      ).toBe(c.expected);
    });
  }

  it("prefers the frozen snapshot over a later packaging rename", () => {
    const n = normalizeLineItemUom({
      quantity: 50,
      display_quantity: 1,
      packaging: { name: "Bag (small)", qty_in_base_uom: 25 },
      uom_snapshot_pack_name: "Bag",
      uom_snapshot_factor: 50,
      uom_snapshot_base_code: "KG",
    });
    expect(n.packaging_label).toBe("Bag");
    expect(n.pack_size).toBe(50);
    expect(n.base_uom_label).toBe("KG");
  });

  it("never invents an 'ea' base label", () => {
    const n = normalizeLineItemUom({ quantity: 5 });
    expect(n.base_uom_label).toBeNull();
  });

  it("derives the display quantity when only the frozen factor is known", () => {
    const n = normalizeLineItemUom({
      quantity: 150,
      uom_snapshot_pack_name: "Bag",
      uom_snapshot_factor: 50,
      uom_snapshot_base_code: "KG",
    });
    expect(n.display_quantity).toBe(3);
  });
});
