/**
 * assembleItemRows — Phase B.0 shared items-section assembler.
 *
 * Produces the abstract rows for the items section of a receipt. Used by
 * BOTH the server ESC/POS builder and the client MonospacePreview so they
 * cannot diverge on column math, item shape, or sub-row formatting.
 *
 * The helper deliberately stays text-only. Engine-specific extras
 * (modifiers/notes that need ESC/POS bold bytes, CP858 translation, etc.)
 * are appended by the caller after `item` rows.
 */
import {
  solveColumns,
  renderHeader,
  renderRow,
  padLR,
  type SolvedColumn,
} from "./engine/ColumnLayout.ts";
import { LAYOUT_REGISTRY, type LayoutId, type LayoutContext } from "./layouts/index.ts";
import { resolveDisplayUnitPrice } from "../documents/lineItemPrice.ts";

export type ItemRowKind = "heading" | "header" | "item" | "subrow";

export interface AssembledItemRow {
  kind: ItemRowKind;
  text: string;
  bold?: boolean;
  /** Index into the input `items` array, or null for heading/header rows. */
  itemIndex: number | null;
}

export interface AssembleItemsCtx extends LayoutContext {}

export interface ItemFormatter {
  /** Format a money amount (no currency symbol). */
  fmtMoney: (n: number) => string;
  /** Format a quantity (integer or 2dp). */
  fmtQty: (n: number) => string;
  /** Truncate to length (already respects ellipsis). */
  truncate: (s: string, max: number) => string;
}

export interface RawItem {
  product_name?: string;
  description?: string;
  sku?: string | null;
  quantity?: number;
  unit_price?: number;
  line_total?: number;
  discount_amount?: number;
  tax_amount?: number;
  tax_rate?: number;
  tax_rate_name?: string;
  // Multi-unit pack provenance.
  display_quantity?: number | null;
  packaging_label?: string | null;
  base_uom_label?: string | null;
  [k: string]: unknown;
}

export interface AssembleItemsInput {
  items: RawItem[];
  layoutId: LayoutId;
  ctx: AssembleItemsCtx;
  contentWidth: number;
  fmt: ItemFormatter;
}

export interface AssembleItemsResult {
  rows: AssembledItemRow[];
  /** Resolved column grid — exposed so callers can render their own value rows if needed. */
  solved: SolvedColumn[];
  layoutId: LayoutId;
}

export function assembleItems(input: AssembleItemsInput): AssembleItemsResult {
  const { items, layoutId, ctx, contentWidth: cw, fmt } = input;
  const template = LAYOUT_REGISTRY[layoutId];
  const colSpecs = template.columns(ctx);
  const solved = solveColumns(colSpecs, cw, 1);
  const rows: AssembledItemRow[] = [];

  if (template.heading) {
    rows.push({ kind: "heading", text: template.heading, bold: true, itemIndex: null });
  }
  if (template.showHeader) {
    rows.push({ kind: "header", text: renderHeader(solved, 1), bold: true, itemIndex: null });
  }

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const qty = Number(it.quantity ?? 0);
    const baseUnitPrice = Number(it.unit_price ?? 0);
    const total = Number(it.line_total ?? qty * baseUnitPrice);
    const baseName = String(it.product_name ?? it.description ?? "Item");
    const nameStr = ctx.truncateLongNames ? fmt.truncate(baseName, ctx.maxNameLen) : baseName;

    // Multi-unit aware qty cell — "1 Box" when packaging present, else "10 ea".
    const displayQty = it.display_quantity != null && Number.isFinite(Number(it.display_quantity))
      ? Number(it.display_quantity)
      : qty;
    const packLabel = (it.packaging_label ?? "").toString().trim();
    const qtyCell = packLabel
      ? `${fmt.fmtQty(displayQty)} ${packLabel}`
      : fmt.fmtQty(qty);
    // Pack price = base_unit_price × (base_qty / display_qty). Shown when
    // packaging is present so the receipt reads "2 Box x 350.00 = 700.00"
    // instead of "100 x 7.00 = 700.00".
    const price = resolveDisplayUnitPrice({
      quantity: qty,
      display_quantity: displayQty,
      packaging_label: packLabel,
      unit_price: baseUnitPrice,
      line_total: it.line_total as number | null | undefined,
    });

    const values: Record<string, string> = {
      sku: String(it.sku ?? ""),
      name: nameStr,
      qty: ctx.showQty ? qtyCell : "",
      unit: fmt.fmtMoney(price),
      total: fmt.fmtMoney(total),
    };

    if (template.itemShape === "two-row") {
      for (const r of renderRow(values, solved, 1)) {
        rows.push({ kind: "item", text: r, itemIndex: idx });
      }
      if (ctx.showSku && it.sku) {
        rows.push({ kind: "subrow", text: "  SKU: " + String(it.sku), itemIndex: idx });
      }
      const leftParts: string[] = [];
      if (ctx.showQty) leftParts.push(qtyCell);
      if (ctx.showUnitPrice) leftParts.push(`x ${fmt.fmtMoney(price)}`);
      const leftLbl = "  " + (leftParts.length ? leftParts.join(" ") : "");
      rows.push({ kind: "subrow", text: padLR(leftLbl, fmt.fmtMoney(total), cw), itemIndex: idx });
    } else {
      for (const r of renderRow(values, solved, 1)) {
        rows.push({ kind: "item", text: r, itemIndex: idx });
      }
      if (ctx.showUnitPrice && it.unit_price != null && layoutId !== "compact") {
        rows.push({ kind: "subrow", text: padLR("  @ " + fmt.fmtMoney(price), "", cw), itemIndex: idx });
      }
    }

    // Multi-unit base-unit breakdown sub-row. Only when the item has
    // packaging context AND the displayed pack qty differs from the
    // underlying base qty (e.g. "2 Strip" sold from a 10-tablet strip
    // prints "(20 ea)" so the customer can reconcile pack vs base).
    if (
      ctx.showBaseUnitBreakdown !== false &&
      packLabel &&
      Number.isFinite(qty) &&
      qty !== displayQty
    ) {
      const baseLbl = (it.base_uom_label ?? "ea").toString().trim() || "ea";
      rows.push({
        kind: "subrow",
        text: "  (" + fmt.fmtQty(qty) + " " + baseLbl + ")",
        itemIndex: idx,
      });
    }

    if (ctx.showDiscount && Number(it.discount_amount ?? 0) > 0) {
      rows.push({
        kind: "subrow",
        text: padLR("  Discount", `-${fmt.fmtMoney(Number(it.discount_amount))}`, cw),
        itemIndex: idx,
      });
    }
    if (ctx.showTaxBreakdown && Number(it.tax_amount ?? 0) > 0) {
      const rateLabel = ctx.showTaxRate && it.tax_rate != null
        ? ` ${Number(it.tax_rate).toFixed(0)}%`
        : "";
      const nameLabel = String(it.tax_rate_name ?? "Tax");
      rows.push({
        kind: "subrow",
        text: padLR(`  ${nameLabel}${rateLabel}`, fmt.fmtMoney(Number(it.tax_amount)), cw),
        itemIndex: idx,
      });
    }
  }

  return { rows, solved, layoutId };
}
